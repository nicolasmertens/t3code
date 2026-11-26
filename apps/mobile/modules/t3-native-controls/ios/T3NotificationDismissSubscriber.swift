import ExpoModulesCore
import UIKit
import UserNotifications

public final class T3NotificationDismissSubscriber: ExpoAppDelegateSubscriber {
  private struct DismissTarget {
    let environmentId: String
    let threadId: String
    let expectedDeepLink: String?
    let expectedThreadIdentifier: String
    let dismissedAt: Date?
  }

  private static let clockSkewToleranceSeconds: TimeInterval = 5.0

  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard let dismiss = userInfo["t3Dismiss"] as? [AnyHashable: Any] else {
      // Expo's AppDelegate subscriber manager waits on every subscriber to complete.
      completionHandler(.noData)
      return
    }

    let targets = Self.parseDismissTargets(from: dismiss)
    guard !targets.isEmpty else {
      completionHandler(.noData)
      return
    }

    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { notifications in
      let matchingIdentifiers = notifications.compactMap { notification -> String? in
        let shouldRemove = targets.contains { target in
          Self.matchesDismissTarget(notification: notification, target: target)
        }
        return shouldRemove ? notification.request.identifier : nil
      }

      guard !matchingIdentifiers.isEmpty else {
        completionHandler(.noData)
        return
      }

      center.removeDeliveredNotifications(withIdentifiers: matchingIdentifiers)
      completionHandler(.newData)
    }
  }

  private static func parseDismissTargets(from dismiss: [AnyHashable: Any]) -> [DismissTarget] {
    var byKey: [String: DismissTarget] = [:]

    func record(environmentId: String, threadId: String, dismissedAt: Date?) {
      guard !environmentId.isEmpty, !threadId.isEmpty else { return }
      let key = "\(environmentId)\u{0000}\(threadId)"
      let existing = byKey[key]
      let resolvedDismissedAt: Date?
      switch (existing?.dismissedAt, dismissedAt) {
      case let (a?, b?):
        resolvedDismissedAt = max(a, b)
      case let (a?, nil):
        resolvedDismissedAt = a
      case let (nil, b?):
        resolvedDismissedAt = b
      case (nil, nil):
        resolvedDismissedAt = nil
      }
      byKey[key] = DismissTarget(
        environmentId: environmentId,
        threadId: threadId,
        expectedDeepLink: threadDeepLink(environmentId: environmentId, threadId: threadId),
        expectedThreadIdentifier: "\(environmentId)/\(threadId)",
        dismissedAt: resolvedDismissedAt
      )
    }

    if let batch = dismiss["dismissals"] as? [[AnyHashable: Any]] {
      for item in batch {
        guard
          let environmentId = item["environmentId"] as? String,
          let threadId = item["threadId"] as? String
        else {
          continue
        }
        let dismissedAt = parseIsoDate(item["dismissedAt"] as? String)
        record(environmentId: environmentId, threadId: threadId, dismissedAt: dismissedAt)
      }
    }

    if
      let environmentId = dismiss["environmentId"] as? String,
      let threadId = dismiss["threadId"] as? String
    {
      let dismissedAt = parseIsoDate(dismiss["dismissedAt"] as? String)
      record(environmentId: environmentId, threadId: threadId, dismissedAt: dismissedAt)
    }

    return Array(byKey.values)
  }

  private static func parseIsoDate(_ raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let parsed = fractional.date(from: raw) {
      return parsed
    }
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    return whole.date(from: raw)
  }

  private static func threadDeepLink(environmentId: String, threadId: String) -> String? {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/")
    guard
      let encodedEnvironmentId = environmentId.addingPercentEncoding(withAllowedCharacters: allowed),
      let encodedThreadId = threadId.addingPercentEncoding(withAllowedCharacters: allowed)
    else {
      return nil
    }
    return "/threads/\(encodedEnvironmentId)/\(encodedThreadId)"
  }

  private static func matchesDismissTarget(
    notification: UNNotification,
    target: DismissTarget
  ) -> Bool {
    let content = notification.request.content
    let userInfo = content.userInfo
    let matchesIdentity =
      matchesDataDictionary(userInfo, target: target)
      || (userInfo["body"] as? [AnyHashable: Any]).map { matchesDataDictionary($0, target: target) } == true
      || content.threadIdentifier == target.expectedThreadIdentifier

    guard matchesIdentity else {
      return false
    }

    guard let dismissedAt = target.dismissedAt else {
      return true
    }

    let notificationDate = extractNotificationDate(notification: notification, userInfo: userInfo)
    return notificationDate <= dismissedAt.addingTimeInterval(clockSkewToleranceSeconds)
  }

  private static func extractNotificationDate(
    notification: UNNotification,
    userInfo: [AnyHashable: Any]
  ) -> Date {
    if
      let body = userInfo["body"] as? [AnyHashable: Any],
      let updatedAt = parseIsoDate(body["updatedAt"] as? String)
    {
      return updatedAt
    }
    if let updatedAt = parseIsoDate(userInfo["updatedAt"] as? String) {
      return updatedAt
    }
    return notification.date
  }

  private static func matchesDataDictionary(
    _ data: [AnyHashable: Any],
    target: DismissTarget
  ) -> Bool {
    if
      let payloadEnvironmentId = data["environmentId"] as? String,
      let payloadThreadId = data["threadId"] as? String,
      payloadEnvironmentId == target.environmentId,
      payloadThreadId == target.threadId
    {
      return true
    }
    if
      let expectedDeepLink = target.expectedDeepLink,
      let payloadDeepLink = data["deepLink"] as? String,
      payloadDeepLink == expectedDeepLink
    {
      return true
    }
    return false
  }
}
