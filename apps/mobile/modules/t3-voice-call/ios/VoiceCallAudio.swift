import AVFoundation
import Foundation

final class VoiceCallAudioEngine {
  var onUplinkPcm16k: ((Data) -> Void)?
  var onLevel: ((Double) -> Void)?
  var onRouteChange: ((String) -> Void)?
  var onError: ((String) -> Void)?

  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var micMixer: AVAudioMixerNode?
  private var playbackFormat: AVAudioFormat?

  private var started = false
  private var muted = false
  private var speakerEnabled = true

  private var resamplePosition: Double = 0
  private var uplinkAccumulator = Data()
  private var lastLevelSentAt: TimeInterval = 0

  private var activeTurnId: UInt32 = 0
  private var queuedBuffers: [(turnId: UInt32, buffer: AVAudioPCMBuffer)] = []
  private var hasStartedTurnPlayback = false
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
      uplinkAccumulator.removeAll(keepingCapacity: true)
      resamplePosition = 0
      activeTurnId = 0
      queuedBuffers.removeAll(keepingCapacity: true)
      hasStartedTurnPlayback = false
      let wasStarted = started
      started = true
      return !wasStarted
    }

    if firstStart {
      try configureAudioSession(speaker: speaker)
      try setupAndStartEngine()
      schedulePostStartWatchdog()
    } else {
      try setSpeaker(speaker)
    }
  }

  func stop() {
    let wasStarted = withLock { () -> Bool in
      let prev = started
      started = false
      muted = false
      uplinkAccumulator.removeAll(keepingCapacity: false)
      queuedBuffers.removeAll(keepingCapacity: false)
      hasStartedTurnPlayback = false
      return prev
    }

    removeObservers()

    if let playerNode {
      playerNode.stop()
      playerNode.reset()
    }
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    engine = nil
    playerNode = nil
    micMixer = nil
    playbackFormat = nil

    if wasStarted {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  func setMuted(_ isMuted: Bool) {
    withLock {
      muted = isMuted
    }
  }

  func setSpeaker(_ enabled: Bool) throws {
    withLock {
      speakerEnabled = enabled
    }
    let session = AVAudioSession.sharedInstance()
    let options: AVAudioSession.CategoryOptions = enabled
      ? [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
      : [.allowBluetoothHFP, .allowBluetoothA2DP]
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
    if !isExternalRouteActive(session.currentRoute) {
      try session.overrideOutputAudioPort(enabled ? .speaker : .none)
    }
    emitCurrentRoute()
  }

  func enqueue(pcm24k: Data, turnId: UInt32) {
    guard pcm24k.count >= 2 else { return }

    let playbackSetup: (player: AVAudioPlayerNode, format: AVAudioFormat)? = withLock {
      guard started, let playerNode, let playbackFormat else { return nil }
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
    guard sampleCount > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)) else {
      return
    }
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    guard let dst = buffer.floatChannelData?[0] else { return }

    pcm24k.withUnsafeBytes { rawBuffer in
      let int16Ptr = rawBuffer.bindMemory(to: Int16.self)
      for i in 0..<sampleCount {
        let sample = Int16(littleEndian: int16Ptr[i])
        dst[i] = Float(sample) / 32768.0
      }
    }

    let buffersToSchedule: [AVAudioPCMBuffer] = withLock {
      guard started, turnId >= activeTurnId else { return [] }
      if !hasStartedTurnPlayback {
        queuedBuffers.append((turnId: turnId, buffer: buffer))
        guard queuedBuffers.count >= 2 else { return [] }
        hasStartedTurnPlayback = true
        let ready = queuedBuffers.map { $0.buffer }
        queuedBuffers.removeAll(keepingCapacity: true)
        return ready
      }
      return [buffer]
    }

    guard !buffersToSchedule.isEmpty else { return }
    for readyBuffer in buffersToSchedule {
      player.scheduleBuffer(readyBuffer, completionCallbackType: .dataPlayedBack)
    }
    if !player.isPlaying {
      player.play()
    }
  }

  func flush(throughTurnId: UInt32) {
    let player = withLock { () -> AVAudioPlayerNode? in
      activeTurnId = max(activeTurnId, throughTurnId)
      queuedBuffers.removeAll(keepingCapacity: true)
      hasStartedTurnPlayback = false
      return playerNode
    }
    guard let player else { return }
    player.stop()
    player.reset()
  }

  private func configureAudioSession(speaker: Bool) throws {
    let session = AVAudioSession.sharedInstance()
    let options: AVAudioSession.CategoryOptions = speaker
      ? [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
      : [.allowBluetoothHFP, .allowBluetoothA2DP]
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
    try session.setPreferredSampleRate(48_000)
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true, options: .notifyOthersOnDeactivation)
    if !isExternalRouteActive(session.currentRoute) {
      try session.overrideOutputAudioPort(speaker ? .speaker : .none)
    }
    emitCurrentRoute()
  }

  private func setupAndStartEngine() throws {
    let audioEngine = AVAudioEngine()
    let inputNode = audioEngine.inputNode
    try inputNode.setVoiceProcessingEnabled(true)
    inputNode.isVoiceProcessingBypassed = false
    inputNode.isVoiceProcessingAGCEnabled = false

    let player = AVAudioPlayerNode()
    audioEngine.attach(player)

    let mixer = AVAudioMixerNode()
    mixer.outputVolume = 0
    audioEngine.attach(mixer)

    guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false) else {
      throw NSError(domain: "T3VoiceCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create 24 kHz audio format"])
    }

    let hwInputFormat = inputNode.outputFormat(forBus: 0)
    audioEngine.connect(player, to: audioEngine.mainMixerNode, format: outFormat)
    audioEngine.connect(audioEngine.mainMixerNode, to: audioEngine.outputNode, format: nil)
    if hwInputFormat.channelCount > 0 && hwInputFormat.sampleRate > 0 {
      audioEngine.connect(inputNode, to: mixer, format: hwInputFormat)
      audioEngine.connect(mixer, to: audioEngine.mainMixerNode, format: hwInputFormat)
    }

    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      self?.handleCapturedBuffer(buffer)
    }

    audioEngine.prepare()
    try audioEngine.start()

    self.engine = audioEngine
    self.playerNode = player
    self.micMixer = mixer
    self.playbackFormat = outFormat
  }

  private func handleCapturedBuffer(_ buffer: AVAudioPCMBuffer) {
    let frameLength = Int(buffer.frameLength)
    guard frameLength > 0, let channelData = buffer.floatChannelData?[0], buffer.format.sampleRate > 0 else {
      return
    }

    let inputRate = buffer.format.sampleRate
    let step = inputRate / 16_000.0
    var sumSquares: Double = 0
    for i in 0..<frameLength {
      let sample = Double(channelData[i])
      sumSquares += sample * sample
    }
    let rms = sqrt(sumSquares / Double(frameLength))
    let normalizedLevel = min(1.0, max(0.0, rms * 5.0))

    let now = ProcessInfo.processInfo.systemUptime
    var shouldEmitLevel = false
    var chunksToSend: [Data] = []

    withLock {
      guard started else { return }

      if now - lastLevelSentAt >= 0.066 {
        lastLevelSentAt = now
        shouldEmitLevel = true
      }

      if !muted {
        var pos = resamplePosition
        let maxIndex = frameLength - 1
        while pos < Double(frameLength) {
          let index0 = Int(pos)
          let frac = Float(pos - Double(index0))
          let s0 = channelData[index0]
          let s1 = index0 < maxIndex ? channelData[index0 + 1] : s0
          let interpolated = s0 + (s1 - s0) * frac
          let clamped = max(-1.0, min(1.0, interpolated))
          var int16 = Int16(clamped * 32767.0).littleEndian
          withUnsafeBytes(of: &int16) { uplinkAccumulator.append(contentsOf: $0) }
          pos += step
        }
        resamplePosition = pos - Double(frameLength)

        while uplinkAccumulator.count >= 3200 {
          let chunk = Data(uplinkAccumulator.prefix(3200))
          uplinkAccumulator.removeFirst(3200)
          chunksToSend.append(chunk)
        }
      } else {
        uplinkAccumulator.removeAll(keepingCapacity: true)
      }
    }

    if shouldEmitLevel {
      onLevel?(muted ? 0 : normalizedLevel)
    }
    for chunk in chunksToSend {
      onUplinkPcm16k?(chunk)
    }
  }

  private func schedulePostStartWatchdog() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      guard let self else { return }
      let isActive = self.withLock { self.started }
      guard isActive, let engine = self.engine, !engine.isRunning else { return }
      do {
        try engine.start()
      } catch {
        self.onError?("Audio engine failed to restart: \(error.localizedDescription)")
      }
    }
  }

  private func isExternalRouteActive(_ route: AVAudioSessionRouteDescription) -> Bool {
    route.outputs.contains { output in
      output.portType == .bluetoothA2DP ||
        output.portType == .bluetoothHFP ||
        output.portType == .bluetoothLE ||
        output.portType == .headphones ||
        output.portType == .headsetMic
    }
  }

  private func emitCurrentRoute() {
    let route = AVAudioSession.sharedInstance().currentRoute
    let portName = route.outputs.first?.portName ?? "Speaker"
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
    ) { [weak self] _ in
      guard let self else { return }
      let isActive = self.withLock { self.started }
      if isActive {
        self.emitCurrentRoute()
      }
    }
    let resetObserver = center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      let shouldRestart = self.withLock { self.started }
      if shouldRestart {
        self.onError?("iOS media services were reset")
      }
    }

    observerTokens = [interruptionObserver, routeObserver, resetObserver]
  }

  private func removeObservers() {
    let center = NotificationCenter.default
    for token in observerTokens {
      center.removeObserver(token)
    }
    observerTokens.removeAll()
    observersRegistered = false
  }

  private func handleInterruption(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
      let rawType = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: rawType)
    else {
      return
    }
    if type == .ended {
      let optionsRaw = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
      let isActive = withLock { started }
      if isActive && options.contains(.shouldResume) {
        try? AVAudioSession.sharedInstance().setActive(true)
        try? engine?.start()
      }
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
