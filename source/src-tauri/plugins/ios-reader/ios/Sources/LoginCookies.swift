import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum LoginCookies {
    static func activeUserId(_ cookies: [HTTPCookie]) -> String? {
        let values = Set(cookies.filter { $0.name == "twid" && ["x.com", ".x.com"].contains($0.domain) && ($0.expiresDate == nil || $0.expiresDate! > Date()) && $0.path == "/" }.compactMap { cookie -> String? in
            let decoded = (cookie.value.removingPercentEncoding ?? cookie.value).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            guard decoded.hasPrefix("u=") else { return nil }
            let id = String(decoded.dropFirst(2))
            return !id.isEmpty && id.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } ? id : nil
        })
        return values.count == 1 ? values.first : nil
    }
    struct Selection { let token: String; let csrf: String; let cookies: [HTTPCookie] }
    static func select(_ cookies: [HTTPCookie]) -> Selection? {
        let valid = cookies.filter { !$0.value.isEmpty && ($0.expiresDate == nil || $0.expiresDate! > Date()) }
        for domain in ["x.com", ".x.com", "twitter.com", ".twitter.com"] {
            let family = valid.filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
            let tokens = family.filter { $0.name == "auth_token" && $0.path == "/" }
            let csrf = family.filter { $0.name == "ct0" && $0.path == "/" }
            // Ambiguous credential cookies must not be silently combined.
            if Set(tokens.map { $0.value }).count == 1, Set(csrf.map { $0.value }).count == 1,
               let token = tokens.first, let csrf = csrf.first {
                let support = valid.filter { ["x.com", "twitter.com"].contains($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) && $0.name != "auth_token" && $0.name != "ct0" }
                return Selection(token: token.value, csrf: csrf.value, cookies: support + [token, csrf])
            }
        }
        return nil
    }
}
