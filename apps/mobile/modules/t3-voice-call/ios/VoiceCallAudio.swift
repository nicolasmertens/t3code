import AVFoundation
import Foundation

final class VoiceCallAudioEngine {
  var onUplinkPcm16k: ((Data) -> Void)?
  var onLevel: ((Double) -> Void)?
  var onRouteChange: ((String) -> Void)?
  var onSpeakingChange: ((Bool) -> Void)?
  var onError: ((String) -> Void)?

  private static let outputSampleRate: Double = 24_000
  private static let inputSampleRate: Double = 16_000
  private static let uplinkChunkBytes = 1_280 // 40 ms at 16 kHz Int16 mono
  private static let speakingHoldSeconds: TimeInterval = 0.35

  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var micMixer: AVAudioMixerNode?
  private var playbackFormat: AVAudioFormat?

  private var started = false
  private var interrupted = false
  private var muted = false
  private var speakerEnabled = true
  private var onLoudspeaker = true
  private var tapInstalled = false

  private var resampleInputRate: Double = 0
  private var resamplePending: [Float] = []
  private var resamplePosition: Double = 0
  private var uplinkAccumulator = Data()
  private var lastLevelSentAt: TimeInterval = 0

  private var activeTurnId: UInt32 = 0
  private var queuedBuffers: [(turnId: UInt32, buffer: AVAudioPCMBuffer)] = []
  private var hasStartedTurnPlayback = false
  private var queuedPlaybackCount = 0
  private var playbackGeneration: UInt64 = 0
  private var speaking = false

  private var recentRestartUptimes: [TimeInterval] = []
  private var observersRegistered = false
  private var observerTokens: [NSObjectProtocol] = []

  deinit {
    stop()
  }

  func start(speaker: Bool) throws {
    registerObserversIfNeeded()

    let firstStart = withLock { () -> Bool in
      speakerEnabled = speaker
      muted = false
      interrupted = false
      resetResamplerLocked()
      activeTurnId = 0
      queuedBuffers.removeAll(keepingCapacity: true)
      hasStartedTurnPlayback = false
      queuedPlaybackCount = 0
      playbackGeneration &+= 1
      speaking = false
      recentRestartUptimes.removeAll(keepingCapacity: true)
      let wasStarted = started
      started = true
      return !wasStarted
    }

    if firstStart {
      try configureAudioSession(speaker: speaker)
      try setupAndStartEngine()
    } else {
      try setSpeaker(speaker)
    }
  }

  func stop() {
    let wasStarted = withLock { () -> Bool in
      let prev = started
      started = false
      interrupted = false
      muted = false
      resetResamplerLocked()
      queuedBuffers.removeAll(keepingCapacity: false)
      hasStartedTurnPlayback = false
      queuedPlaybackCount = 0
      playbackGeneration &+= 1
      speaking = false
      return prev
    }

    removeObservers()
    teardownEngine()

    if wasStarted {
      onSpeakingChange?(false)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  func setMuted(_ isMuted: Bool) {
    withLock {
      muted = isMuted
      if isMuted {
        uplinkAccumulator.removeAll(keepingCapacity: true)
      }
    }
  }

  func setSpeaker(_ enabled: Bool) throws {
    withLock {
      speakerEnabled = enabled
    }
    try applyRoute(speaker: enabled)
  }

  func enqueue(pcm24k: Data, turnId: UInt32) {
    guard pcm24k.count >= 2 else { return }

    let playbackSetup: (player: AVAudioPlayerNode, format: AVAudioFormat)? = withLock {
      guard started, !interrupted, let playerNode, let playbackFormat else { return nil }
      if turnId < activeTurnId { return nil }
      if turnId > activeTurnId {
        activeTurnId = turnId
        queuedBuffers.removeAll(keepingCapacity: true)
        hasStartedTurnPlayback = false
      }
      return (playerNode, playbackFormat)
    }
    guard let (player, format) = playbackSetup else { return }

    let sampleCount = pcm24k.count / 2
    guard sampleCount > 0,
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount))
    else {
      return
    }
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    guard let dst = buffer.floatChannelData?[0] else { return }

    pcm24k.withUnsafeBytes { rawBuffer in
      let int16Ptr = rawBuffer.bindMemory(to: Int16.self)
      for i in 0..<sampleCount {
        let sample = Int16(littleEndian: int16Ptr[i])
        dst[i] = Float(sample) / 32_768.0
      }
    }

    let scheduleResult: (buffers: [AVAudioPCMBuffer], generation: UInt64, becameSpeaking: Bool) = withLock {
      guard started, !interrupted, turnId >= activeTurnId else {
        return ([], playbackGeneration, false)
      }
      let ready: [AVAudioPCMBuffer]
      if !hasStartedTurnPlayback {
        queuedBuffers.append((turnId: turnId, buffer: buffer))
        guard queuedBuffers.count >= 2 else {
          return ([], playbackGeneration, false)
        }
        hasStartedTurnPlayback = true
        ready = queuedBuffers.map { $0.buffer }
        queuedBuffers.removeAll(keepingCapacity: true)
      } else {
        ready = [buffer]
      }
      queuedPlaybackCount += ready.count
      let becameSpeaking = !speaking
      speaking = true
      return (ready, playbackGeneration, becameSpeaking)
    }

    guard !scheduleResult.buffers.isEmpty else { return }
    if scheduleResult.becameSpeaking {
      onSpeakingChange?(true)
    }

    let generation = scheduleResult.generation
    for readyBuffer in scheduleResult.buffers {
      player.scheduleBuffer(readyBuffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
        self?.handleBufferPlayedBack(generation: generation)
      }
    }
    if !player.isPlaying {
      player.play()
    }
  }

  func flush(throughTurnId: UInt32) {
    let (player, endedSpeaking) = withLock { () -> (AVAudioPlayerNode?, Bool) in
      activeTurnId = max(activeTurnId, throughTurnId)
      queuedBuffers.removeAll(keepingCapacity: true)
      hasStartedTurnPlayback = false
      queuedPlaybackCount = 0
      playbackGeneration &+= 1
      let wasSpeaking = speaking
      speaking = false
      return (playerNode, wasSpeaking)
    }
    if let player {
      player.stop()
      player.reset()
      if engine?.isRunning == true {
        player.play()
      }
    }
    if endedSpeaking {
      onSpeakingChange?(false)
    }
  }

  func interruptPlayback() {
    let nextTurn = withLock { activeTurnId + 1 }
    flush(throughTurnId: nextTurn)
  }

  private func handleBufferPlayedBack(generation: UInt64) {
    let shouldScheduleDrainCheck = withLock { () -> Bool in
      guard generation == playbackGeneration, queuedPlaybackCount > 0 else { return false }
      queuedPlaybackCount -= 1
      return queuedPlaybackCount == 0
    }
    guard shouldScheduleDrainCheck else { return }

    DispatchQueue.global(qos: .userInteractive).asyncAfter(
      deadline: .now() + Self.speakingHoldSeconds
    ) { [weak self] in
      guard let self else { return }
      let endedSpeaking = self.withLock { () -> Bool in
        guard generation == self.playbackGeneration, self.queuedPlaybackCount == 0, self.speaking else {
          return false
        }
        self.speaking = false
        return true
      }
      if endedSpeaking {
        self.onSpeakingChange?(false)
      }
    }
  }

  private func configureAudioSession(speaker: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
    if speaker {
      options.insert(.defaultToSpeaker)
    }
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
    try session.setPreferredSampleRate(48_000)
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true, options: .notifyOthersOnDeactivation)
    try applyRoute(speaker: speaker)
  }

  private func applyRoute(speaker: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    let external = isExternalRouteActive(session.currentRoute)
    if !external {
      try session.overrideOutputAudioPort(speaker ? .speaker : .none)
    }
    updateCurrentRouteState()
  }

  private func setupAndStartEngine() throws {
    teardownEngine()

    let audioEngine = AVAudioEngine()
    let inputNode = audioEngine.inputNode
    if !inputNode.isVoiceProcessingEnabled {
      try inputNode.setVoiceProcessingEnabled(true)
    }
    inputNode.isVoiceProcessingBypassed = false
    inputNode.isVoiceProcessingAGCEnabled = false

    let hwInputFormat = inputNode.outputFormat(forBus: 0)
    guard hwInputFormat.channelCount > 0, hwInputFormat.sampleRate > 0 else {
      throw NSError(
        domain: "T3VoiceCall",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "No microphone input format available."]
      )
    }

    guard let outFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Self.outputSampleRate,
      channels: 1,
      interleaved: false
    ) else {
      throw NSError(
        domain: "T3VoiceCall",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Failed to create 24 kHz audio format"]
      )
    }

    let player = AVAudioPlayerNode()
    let mixer = AVAudioMixerNode()

    audioEngine.attach(player)
    audioEngine.attach(mixer)

    // VoiceProcessingIO expects the mainMixer -> outputNode connection to match the mono capture format
    // so hardware AEC sees an accurate far-end reference.
    audioEngine.connect(audioEngine.mainMixerNode, to: audioEngine.outputNode, format: hwInputFormat)
    audioEngine.connect(player, to: audioEngine.mainMixerNode, format: outFormat)

    // Keep the microphone path connected through a silent mixer sink (volume set AFTER wiring)
    // so inputNode pulls continuously without leaking local mic into the speaker.
    audioEngine.disconnectNodeOutput(inputNode)
    audioEngine.connect(inputNode, to: mixer, format: hwInputFormat)
    audioEngine.connect(mixer, to: audioEngine.mainMixerNode, format: nil)
    mixer.outputVolume = 0

    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 2_048, format: hwInputFormat) { [weak self] buffer, _ in
      self?.handleCapturedBuffer(buffer)
    }

    let configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: audioEngine,
      queue: nil
    ) { [weak self] _ in
      self?.restartIfNeeded(reason: "configuration change")
    }

    withLock {
      self.engine = audioEngine
      self.playerNode = player
      self.micMixer = mixer
      self.playbackFormat = outFormat
      self.tapInstalled = true
      self.observerTokens.append(configObserver)
    }

    audioEngine.prepare()
    try audioEngine.start()
    player.play()
    schedulePostStartWatchdog()
  }

  private func teardownEngine() {
    let (currentPlayer, currentEngine, hadTap) = withLock {
      () -> (AVAudioPlayerNode?, AVAudioEngine?, Bool) in
      let p = playerNode
      let e = engine
      let t = tapInstalled
      playerNode = nil
      engine = nil
      micMixer = nil
      playbackFormat = nil
      tapInstalled = false
      return (p, e, t)
    }
    currentPlayer?.stop()
    currentPlayer?.reset()
    if let currentEngine {
      if hadTap {
        currentEngine.inputNode.removeTap(onBus: 0)
      }
      currentEngine.stop()
    }
  }

  private func extractFirstChannel(from buffer: AVAudioPCMBuffer) -> [Float]? {
    let frames = Int(buffer.frameLength)
    guard frames > 0 else { return nil }
    let stride = buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1
    if let channels = buffer.floatChannelData {
      let base = channels[0]
      var out = [Float](repeating: 0, count: frames)
      for i in 0..<frames {
        out[i] = base[i * stride]
      }
      return out
    }
    if let channels = buffer.int16ChannelData {
      let base = channels[0]
      var out = [Float](repeating: 0, count: frames)
      for i in 0..<frames {
        out[i] = Float(base[i * stride]) / 32_768.0
      }
      return out
    }
    if let channels = buffer.int32ChannelData {
      let base = channels[0]
      var out = [Float](repeating: 0, count: frames)
      for i in 0..<frames {
        out[i] = Float(base[i * stride]) / 2_147_483_648.0
      }
      return out
    }
    return nil
  }

  private func handleCapturedBuffer(_ buffer: AVAudioPCMBuffer) {
    let inputRate = buffer.format.sampleRate
    guard inputRate > 0, let samples = extractFirstChannel(from: buffer) else { return }

    var sumSquares: Double = 0
    for sample in samples {
      let d = Double(sample)
      sumSquares += d * d
    }
    let rms = sqrt(sumSquares / Double(samples.count))
    let normalizedLevel = min(1.0, max(0.0, rms * 5.0))
    let now = ProcessInfo.processInfo.systemUptime

    var shouldEmitLevel = false
    var isMuted = false
    var chunksToSend: [Data] = []

    withLock {
      guard started, !interrupted else { return }
      isMuted = muted

      if now - lastLevelSentAt >= 0.066 {
        lastLevelSentAt = now
        shouldEmitLevel = true
      }

      if muted {
        resamplePending.removeAll(keepingCapacity: true)
        resamplePosition = 0
        uplinkAccumulator.removeAll(keepingCapacity: true)
        return
      }

      if resampleInputRate != inputRate {
        resampleInputRate = inputRate
        resamplePending.removeAll(keepingCapacity: true)
        resamplePosition = 0
      }

      let echoGated = speaking && onLoudspeaker
      let step = inputRate / Self.inputSampleRate
      resamplePending.append(contentsOf: samples)

      // Box-filter downsampling averages each 16 kHz output window to prevent aliasing distortion.
      var resampled: [Float] = []
      resampled.reserveCapacity(Int(Double(resamplePending.count) / max(1.0, step)) + 1)

      if step >= 1.0 {
        while resamplePosition + step <= Double(resamplePending.count) {
          let start = Int(resamplePosition)
          let end = max(Int(resamplePosition + step), start + 1)
          var sum: Float = 0
          for idx in start..<end {
            sum += resamplePending[idx]
          }
          resampled.append(sum / Float(end - start))
          resamplePosition += step
        }
      } else {
        while resamplePosition + 1.0 < Double(resamplePending.count) {
          let index = Int(resamplePosition)
          let fraction = Float(resamplePosition - Double(index))
          let s0 = resamplePending[index]
          let s1 = resamplePending[index + 1]
          resampled.append(s0 + (s1 - s0) * fraction)
          resamplePosition += step
        }
      }

      let consumed = min(Int(resamplePosition), resamplePending.count)
      if consumed > 0 {
        resamplePending.removeFirst(consumed)
        resamplePosition -= Double(consumed)
      }

      if echoGated {
        let silenceBytes = resampled.count * 2
        if silenceBytes > 0 {
          uplinkAccumulator.append(Data(count: silenceBytes))
        }
      } else {
        for sample in resampled {
          let clamped = max(-1.0, min(1.0, sample))
          var int16 = Int16(clamped * 32_767.0).littleEndian
          withUnsafeBytes(of: &int16) { uplinkAccumulator.append(contentsOf: $0) }
        }
      }

      while uplinkAccumulator.count >= Self.uplinkChunkBytes {
        let chunk = Data(uplinkAccumulator.prefix(Self.uplinkChunkBytes))
        uplinkAccumulator.removeFirst(Self.uplinkChunkBytes)
        chunksToSend.append(chunk)
      }
    }

    if shouldEmitLevel {
      onLevel?(isMuted ? 0 : normalizedLevel)
    }
    for chunk in chunksToSend {
      onUplinkPcm16k?(chunk)
    }
  }

  private func resetResamplerLocked() {
    resampleInputRate = 0
    resamplePending.removeAll(keepingCapacity: true)
    resamplePosition = 0
    uplinkAccumulator.removeAll(keepingCapacity: true)
  }

  private func schedulePostStartWatchdog() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      self?.restartIfNeeded(reason: "post-start check")
    }
  }

  private func restartIfNeeded(reason: String) {
    let shouldRestart = withLock { () -> Bool in
      guard started, !interrupted else { return false }
      guard let currentEngine = engine, !currentEngine.isRunning else { return false }
      let now = ProcessInfo.processInfo.systemUptime
      recentRestartUptimes = recentRestartUptimes.filter { now - $0 < 10.0 } + [now]
      return recentRestartUptimes.count <= 6
    }

    let exceededBudget = withLock { started && !interrupted && engine?.isRunning == false && recentRestartUptimes.count > 6 }
    if exceededBudget {
      onError?("Audio engine kept stopping (\(reason))")
      return
    }
    guard shouldRestart else { return }

    do {
      try setupAndStartEngine()
    } catch {
      onError?("Audio engine restart failed: \(error.localizedDescription)")
    }
  }

  private func isExternalRouteActive(_ route: AVAudioSessionRouteDescription) -> Bool {
    route.outputs.contains { output in
      output.portType == .bluetoothA2DP ||
        output.portType == .bluetoothHFP ||
        output.portType == .bluetoothLE ||
        output.portType == .headphones ||
        output.portType == .headsetMic ||
        output.portType == .carAudio ||
        output.portType == .airPlay
    }
  }

  private func updateCurrentRouteState() {
    let route = AVAudioSession.sharedInstance().currentRoute
    let builtInSpeaker = route.outputs.contains { $0.portType == .builtInSpeaker }
    let portName = route.outputs.first?.portName ?? (builtInSpeaker ? "Speaker" : "Audio")
    withLock {
      onLoudspeaker = builtInSpeaker
    }
    onRouteChange?(portName)
  }

  private func registerObserversIfNeeded() {
    guard !observersRegistered else { return }
    observersRegistered = true
    let center = NotificationCenter.default

    let interruptionObserver = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] notification in
      self?.handleInterruption(notification)
    }
    let routeObserver = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] notification in
      self?.handleRouteChange(notification)
    }
    let resetObserver = center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] _ in
      self?.handleMediaReset()
    }

    withLock {
      observerTokens.append(contentsOf: [interruptionObserver, routeObserver, resetObserver])
    }
  }

  private func removeObservers() {
    let tokens = withLock { () -> [NSObjectProtocol] in
      let existing = observerTokens
      observerTokens.removeAll()
      observersRegistered = false
      return existing
    }
    let center = NotificationCenter.default
    for token in tokens {
      center.removeObserver(token)
    }
  }

  private func handleInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
      let rawType = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: rawType)
    else {
      return
    }
    let isStarted = withLock { started }
    guard isStarted else { return }

    if type == .began {
      withLock { interrupted = true }
      interruptPlayback()
      teardownEngine()
      return
    }

    if type == .ended {
      withLock { interrupted = false }
      try? AVAudioSession.sharedInstance().setActive(true)
      do {
        try setupAndStartEngine()
      } catch {
        onError?("Failed to resume audio after interruption: \(error.localizedDescription)")
      }
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    let isStarted = withLock { started }
    guard isStarted else { return }

    let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
    let reason = rawReason.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
    updateCurrentRouteState()

    if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable {
      interruptPlayback()
      let speaker = withLock { speakerEnabled }
      try? applyRoute(speaker: speaker)
      schedulePostStartWatchdog()
    }
  }

  private func handleMediaReset() {
    let (isStarted, speaker) = withLock { (started, speakerEnabled) }
    guard isStarted else { return }
    do {
      try configureAudioSession(speaker: speaker)
      try setupAndStartEngine()
    } catch {
      onError?("iOS media services were reset: \(error.localizedDescription)")
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
