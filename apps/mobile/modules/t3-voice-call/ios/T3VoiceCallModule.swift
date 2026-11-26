import ExpoModulesCore
import Foundation

public final class T3VoiceCallModule: Module {
  private let lock = NSLock()
  private let audio = VoiceCallAudioEngine()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var pingTimer: DispatchSourceTimer?
  private var initialConfigJson: String?
  private var intentionalStop = false

  private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()

  public func definition() -> ModuleDefinition {
    Name("T3VoiceCall")
    Events("onState", "onEvent", "onLevel", "onRoute", "onError")

    AsyncFunction("start") { (urlString: String, configJson: String, speaker: Bool) in
      guard let url = URL(string: urlString) else {
        throw NSError(domain: "T3VoiceCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid WebSocket URL"])
      }
      self.teardownSession(intentional: true)

      self.audio.onUplinkPcm16k = { [weak self] pcm in
        self?.sendAudioFrame(pcm)
      }
      self.audio.onLevel = { [weak self] level in
        self?.sendEvent("onLevel", ["level": level])
      }
      self.audio.onRouteChange = { [weak self] route in
        self?.sendEvent("onRoute", ["route": route])
      }
      self.audio.onError = { [weak self] message in
        self?.sendEvent("onError", ["message": message])
      }

      try self.audio.start(speaker: speaker)

      let urlSession = self.makeSession()
      let socketTask = urlSession.webSocketTask(with: url)
      socketTask.maximumMessageSize = 8 * 1024 * 1024

      self.withLock {
        self.intentionalStop = false
        self.session = urlSession
        self.task = socketTask
        self.initialConfigJson = configJson
      }

      self.sendEvent("onState", ["state": "connecting"])
      socketTask.resume()
      self.receiveLoop(task: socketTask)
    }

    Function("stop") {
      self.teardownSession(intentional: true)
      self.audio.stop()
      self.sendEvent("onState", ["state": "ended"])
    }

    Function("setMuted") { (muted: Bool) in
      self.audio.setMuted(muted)
    }

    Function("setSpeaker") { (speaker: Bool) in
      try self.audio.setSpeaker(speaker)
    }

    Function("sendControl") { (json: String) in
      guard let socketTask = self.withLock({ self.task }) else { return }
      socketTask.send(.string(json)) { [weak self] error in
        if let error {
          self?.sendEvent("onError", ["message": error.localizedDescription])
        }
      }
    }

    OnDestroy {
      self.teardownSession(intentional: true)
      self.audio.stop()
    }
  }

  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.default
    // Dev clients register URLProtocol classes that intercept WebSocket upgrades.
    configuration.protocolClasses = []
    return URLSession(configuration: configuration, delegate: VoiceCallSocketDelegate(module: self), delegateQueue: delegateQueue)
  }

  private func sendAudioFrame(_ pcm: Data) {
    guard let socketTask = withLock({ task }), socketTask.state == .running else { return }
    var frame = Data(capacity: 5 + pcm.count)
    frame.append(0x01)
    var zeroTurnId = UInt32(0).bigEndian
    withUnsafeBytes(of: &zeroTurnId) { frame.append(contentsOf: $0) }
    frame.append(pcm)
    socketTask.send(.data(frame)) { _ in }
  }

  private func receiveLoop(task socketTask: URLSessionWebSocketTask) {
    socketTask.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.data(let data)):
        if data.count >= 5 && data[0] == 0x02 {
          let turnId = data.withUnsafeBytes { raw -> UInt32 in
            let b1 = UInt32(raw[1]) << 24
            let b2 = UInt32(raw[2]) << 16
            let b3 = UInt32(raw[3]) << 8
            let b4 = UInt32(raw[4])
            return b1 | b2 | b3 | b4
          }
          let pcm = data.subdata(in: 5..<data.count)
          self.audio.enqueue(pcm24k: pcm, turnId: turnId)
        }
        self.receiveLoop(task: socketTask)

      case .success(.string(let text)):
        if let data = text.data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = parsed["type"] as? String,
          type == "interrupt",
          let turnIdNum = parsed["turnId"] as? NSNumber {
          self.audio.flush(throughTurnId: turnIdNum.uint32Value)
        }
        self.sendEvent("onEvent", ["json": text])
        self.receiveLoop(task: socketTask)

      case .success:
        self.receiveLoop(task: socketTask)

      case .failure(let error):
        let isActive = self.withLock { self.task === socketTask && !self.intentionalStop }
        if isActive {
          self.sendEvent("onError", ["message": error.localizedDescription])
          self.sendEvent("onState", ["state": "disconnected"])
          self.teardownSession(intentional: false)
        }
      }
    }
  }

  private func startPingWatchdog(task socketTask: URLSessionWebSocketTask) {
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + 15, repeating: 15)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      let isCurrent = self.withLock { self.task === socketTask && !self.intentionalStop }
      guard isCurrent else {
        timer.cancel()
        return
      }
      socketTask.sendPing { [weak self] error in
        guard let self, let error else { return }
        let stillCurrent = self.withLock { self.task === socketTask && !self.intentionalStop }
        if stillCurrent {
          self.sendEvent("onError", ["message": "Voice connection ping timeout: \(error.localizedDescription)"])
          self.sendEvent("onState", ["state": "disconnected"])
          self.teardownSession(intentional: false)
        }
      }
    }
    withLock {
      pingTimer?.cancel()
      pingTimer = timer
    }
    timer.resume()
  }

  fileprivate func didOpen(task socketTask: URLSessionWebSocketTask) {
    let configJson = withLock { () -> String? in
      guard self.task === socketTask else { return nil }
      return self.initialConfigJson
    }
    guard let configJson else { return }
    sendEvent("onState", ["state": "connected"])
    startPingWatchdog(task: socketTask)
    socketTask.send(.string(configJson)) { [weak self] error in
      if let error {
        self?.sendEvent("onError", ["message": error.localizedDescription])
      }
    }
  }

  fileprivate func didClose(task socketTask: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode) {
    let wasExpected = withLock { () -> Bool in
      guard self.task === socketTask else { return true }
      return self.intentionalStop || code == .normalClosure
    }
    teardownSession(intentional: false)
    sendEvent("onState", ["state": wasExpected ? "ended" : "disconnected"])
  }

  fileprivate func didComplete(task socketTask: URLSessionTask, error: Error?) {
    let shouldNotify = withLock { () -> Bool in
      guard self.task === socketTask, !self.intentionalStop else { return false }
      return true
    }
    teardownSession(intentional: false)
    if shouldNotify {
      if let error {
        sendEvent("onError", ["message": error.localizedDescription])
      }
      sendEvent("onState", ["state": "disconnected"])
    }
  }

  private func teardownSession(intentional: Bool) {
    let (timer, currentTask, currentSession) = withLock { () -> (DispatchSourceTimer?, URLSessionWebSocketTask?, URLSession?) in
      intentionalStop = intentional
      let t = pingTimer
      pingTimer = nil
      let wt = task
      task = nil
      let s = session
      session = nil
      return (t, wt, s)
    }
    timer?.cancel()
    if intentional {
      currentTask?.cancel(with: .normalClosure, reason: nil)
    } else {
      currentTask?.cancel()
    }
    currentSession?.invalidateAndCancel()
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private final class VoiceCallSocketDelegate: NSObject, URLSessionWebSocketDelegate {
  weak var module: T3VoiceCallModule?

  init(module: T3VoiceCallModule) {
    self.module = module
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    module?.didOpen(task: webSocketTask)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    module?.didClose(task: webSocketTask, code: closeCode)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    module?.didComplete(task: task, error: error)
  }
}
