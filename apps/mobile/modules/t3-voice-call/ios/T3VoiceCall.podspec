Pod::Spec.new do |s|
  s.name = 'T3VoiceCall'
  s.version = '1.0.0'
  s.summary = 'Full-duplex native iOS voice audio and WebSocket transport for Browne Talk to Fleet.'
  s.description = 'Unifies AVAudioEngine with VoiceProcessingIO AEC and direct URLSessionWebSocketTask binary/control framing with native interrupt flush.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation'
end
