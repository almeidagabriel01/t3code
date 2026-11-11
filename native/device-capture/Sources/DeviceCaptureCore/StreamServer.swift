import Foundation
import Network

/// Serves serve-sim's helper routes on loopback: `/stream.avcc`, `/config` and `/health`.
public final class StreamServer {
  private final class Subscriber {
    let connection: NWConnection
    var awaitingKeyframe = true
    var description: Data?
    var pending = 0
    init(_ connection: NWConnection) { self.connection = connection }
  }

  // A viewer this far behind is dropped; reconnecting gets it a fresh keyframe.
  private static let maxPendingFrames = 120

  private let queue = DispatchQueue(label: "t3.device-capture.server")
  private let requestedPort: UInt16
  private let onSubscriber: () -> Void
  private var listener: NWListener?
  private var subscribers: [ObjectIdentifier: Subscriber] = [:]
  private var size: (width: Int, height: Int, sourceWidth: Int, sourceHeight: Int)?

  /// `onSubscriber` runs on the server's queue each time a viewer starts reading the stream.
  public init(port: UInt16, onSubscriber: @escaping () -> Void) {
    self.requestedPort = port
    self.onSubscriber = onSubscriber
  }

  /// Calls back once with the bound port, or with the reason the port could not be bound.
  public func start(_ completion: @escaping (Result<UInt16, Error>) -> Void) {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    // Without a required endpoint a listener accepts on every interface.
    parameters.requiredLocalEndpoint = .hostPort(
      host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: requestedPort) ?? .any)
    let listener: NWListener
    do {
      listener = try NWListener(using: parameters)
    } catch {
      completion(.failure(error))
      return
    }
    self.listener = listener
    var reported = false
    listener.stateUpdateHandler = { state in
      guard !reported else { return }
      switch state {
      case .ready:
        reported = true
        completion(.success(listener.port?.rawValue ?? 0))
      case .failed(let error), .waiting(let error):
        reported = true
        listener.cancel()
        completion(.failure(error))
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.start(queue: queue)
  }

  public func stop() {
    queue.sync {
      listener?.cancel()
      listener = nil
      for subscriber in subscribers.values { subscriber.connection.cancel() }
      subscribers.removeAll()
    }
  }

  public func broadcast(_ frame: EncodedFrame) {
    queue.async { [self] in
      size = (frame.width, frame.height, frame.sourceWidth, frame.sourceHeight)
      for subscriber in subscribers.values {
        if subscriber.awaitingKeyframe && !frame.isKeyframe { continue }
        if subscriber.pending > Self.maxPendingFrames {
          drop(subscriber)
          continue
        }
        var bytes = Data()
        // Sent once, and again only when the frame size changes: each one resets the viewer's decoder.
        if let description = frame.description, description != subscriber.description {
          subscriber.description = description
          bytes.append(envelope(.description, description))
        }
        bytes.append(envelope(frame.isKeyframe ? .keyframe : .delta, frame.data))
        subscriber.awaitingKeyframe = false
        subscriber.pending += 1
        subscriber.connection.send(
          content: bytes,
          completion: .contentProcessed { [weak self, weak subscriber] error in
            guard let subscriber else { return }
            subscriber.pending -= 1
            if error != nil { self?.drop(subscriber) }
          })
      }
    }
  }

  private func drop(_ subscriber: Subscriber) {
    subscribers.removeValue(forKey: ObjectIdentifier(subscriber))
    subscriber.connection.cancel()
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    readRequest(connection, Data())
  }

  private func readRequest(_ connection: NWConnection, _ buffered: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, error in
      guard let self else { return }
      var buffered = buffered
      if let data { buffered.append(data) }
      if let end = buffered.range(of: Data("\r\n\r\n".utf8)) {
        self.route(connection, String(decoding: buffered[..<end.lowerBound], as: UTF8.self))
      } else if done || error != nil || buffered.count > 8192 {
        connection.cancel()
      } else {
        self.readRequest(connection, buffered)
      }
    }
  }

  private func route(_ connection: NWConnection, _ head: String) {
    let requestLine = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else { return respond(connection, "400 Bad Request", ["error": "bad_request"]) }
    guard parts[0] == "GET" else {
      return respond(connection, "405 Method Not Allowed", ["error": "method_not_allowed"])
    }
    let path = parts[1].split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
    switch path {
    case "/stream.avcc":
      stream(connection)
    case "/health":
      respond(connection, "200 OK", ["status": "ok"])
    case "/config":
      guard let size else { return respond(connection, "503 Service Unavailable", ["error": "no_frame"]) }
      respond(
        connection, "200 OK",
        [
          "width": size.width, "height": size.height,
          "sourceWidth": size.sourceWidth, "sourceHeight": size.sourceHeight,
          "orientation": size.width > size.height ? "landscape_left" : "portrait",
          "inputUnavailable": true, "keyboardUnavailable": true,
        ])
    default:
      respond(connection, "404 Not Found", ["error": "not_found"])
    }
  }

  private func respond(_ connection: NWConnection, _ status: String, _ body: [String: Any]) {
    let json = encodeJSONLine(body)
    let head =
      "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(json.utf8.count)\r\n"
      + "Cache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n"
    connection.send(
      content: Data((head + json).utf8),
      completion: .contentProcessed { _ in connection.cancel() })
  }

  private func stream(_ connection: NWConnection) {
    // No length: the body runs until either side closes, as serve-sim's does.
    let head =
      "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
      + "Cache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n"
    let subscriber = Subscriber(connection)
    connection.send(
      content: Data(head.utf8),
      completion: .contentProcessed { [weak self, weak subscriber] error in
        guard let self, let subscriber else { return }
        if error != nil { return self.drop(subscriber) }
        self.subscribers[ObjectIdentifier(subscriber)] = subscriber
        self.watchClose(subscriber)
        self.onSubscriber()
      })
    // Holds the subscriber until it is registered or the send fails.
    connection.stateUpdateHandler = { [weak self, subscriber] state in
      switch state {
      case .failed, .cancelled: self?.subscribers.removeValue(forKey: ObjectIdentifier(subscriber))
      default: break
      }
    }
  }

  private func watchClose(_ subscriber: Subscriber) {
    subscriber.connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) {
      [weak self, weak subscriber] _, _, done, error in
      guard let self, let subscriber else { return }
      if done || error != nil { self.drop(subscriber) } else { self.watchClose(subscriber) }
    }
  }
}
