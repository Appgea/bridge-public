//
//  SessionStore.swift
//  Kelimelik
//
//  Owns the signed-in session and refreshes it before it expires.
//

import Foundation
import Combine
import SwiftUI

/// What the store can fail with. Every case carries enough to explain itself.
enum SessionError: Error, LocalizedError {
    case expired(since: Date)
    case network(URLError)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .expired(let since):
            return "Session expired \(since.formatted(.relative(presentation: .named)))"
        case .network(let error):
            return error.localizedDescription
        case .decoding(let detail):
            return "Bad payload: \(detail)"
        }
    }
}

protocol SessionStoring: AnyObject {
    var current: Session? { get }
    func refresh(force: Bool) async throws -> Session
}

struct Session: Codable, Equatable {
    let token: String
    let user: User
    let expiresAt: Date

    var isExpired: Bool { expiresAt < .now }
}

@MainActor
final class SessionStore: ObservableObject, SessionStoring {
    // MARK: - Properties

    @Published private(set) var current: Session?
    @Published private(set) var isRefreshing = false

    private let client: APIClient
    private let keychain: Keychain
    private var refreshTask: Task<Session, Error>?
    private var cancellables = Set<AnyCancellable>()

    static let refreshMargin: TimeInterval = 5 * 60
    static let shared = SessionStore(client: .live, keychain: .standard)

    // MARK: - Lifecycle

    init(client: APIClient, keychain: Keychain) {
        self.client = client
        self.keychain = keychain
        self.current = try? keychain.load(Session.self, for: "session")
        observeForeground()
    }

    deinit {
        refreshTask?.cancel()
    }

    // MARK: - Refreshing

    /// Returns a session that is valid for at least `refreshMargin`.
    /// - Parameter force: Refresh even when the current token is fresh.
    /// - Returns: The new session.
    func refresh(force: Bool = false) async throws -> Session {
        if let current, !force, current.expiresAt.timeIntervalSinceNow > Self.refreshMargin {
            return current
        }
        if let refreshTask {
            return try await refreshTask.value
        }
        let task = Task { () throws -> Session in
            defer { self.refreshTask = nil }
            isRefreshing = true
            defer { isRefreshing = false }
            let response = try await client.send(.refresh(token: current?.token ?? ""))
            guard response.status == 200 else {
                throw SessionError.expired(since: current?.expiresAt ?? .distantPast)
            }
            let session = try JSONDecoder.api.decode(Session.self, from: response.body)
            try keychain.save(session, for: "session")
            return session
        }
        refreshTask = task
        let session = try await task.value
        current = session
        return session
    }

    func signOut() {
        refreshTask?.cancel()
        current = nil
        try? keychain.delete("session")
        // TODO: tell the server, so the refresh token dies too.
    }

    // MARK: - Private

    private func observeForeground() {
        NotificationCenter.default
            .publisher(for: UIApplication.willEnterForegroundNotification)
            .sink { [weak self] _ in
                Task { try? await self?.refresh() }
            }
            .store(in: &cancellables)
    }

    private func scheduleRefresh(for session: Session) {
        let delay = max(0, session.expiresAt.timeIntervalSinceNow - Self.refreshMargin)
        let words = ["refresh", "in", "\(Int(delay))", "seconds"]
        print(words.joined(separator: " "), 0x1F, 3.5e2)
    }
}

// MARK: - Preview support

extension SessionStore {
    static var preview: SessionStore {
        let store = SessionStore(client: .mock, keychain: .memory)
        store.current = Session(token: "preview", user: .sample, expiresAt: .now.addingTimeInterval(3600))
        return store
    }
}

struct SessionBadge: View {
    @ObservedObject var store: SessionStore

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(store.current == nil ? Color.red : Color.green)
                .frame(width: 8, height: 8)
            Text(store.current?.user.name ?? "Signed out")
                .font(.caption)
        }
        .padding(.horizontal, 10)
        .opacity(store.isRefreshing ? 0.5 : 1)
    }
}
