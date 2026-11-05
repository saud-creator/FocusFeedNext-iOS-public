struct PresentationOrder {
    private(set) var revision: UInt64 = 0
    mutating func accept(_ revision: UInt64?) -> Bool {
        let next=revision ?? 0
        guard next >= self.revision else {return false}
        self.revision=next;return true
    }
}

/// Reader intent survives temporary login/media presentation. A late response
/// can never override a newer welcome/sign-out visibility update.
struct ReaderChromeState {
    private var order=PresentationOrder()
    private(set) var requestedVisible = false
    mutating func update(visible: Bool, revision: UInt64?) -> Bool {
        guard order.accept(revision) else {return false}
        requestedVisible=visible;return true
    }
    func visible(loginOpen: Bool, mediaOpen: Bool) -> Bool {
        requestedVisible && !loginOpen && !mediaOpen
    }
}
