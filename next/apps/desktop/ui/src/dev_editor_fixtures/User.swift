import Foundation

struct User: Codable, Equatable, Identifiable {
    let id: UUID
    var name: String
    var email: String

    static let sample = User(id: UUID(), name: "Ada", email: "ada@example.com")
}
