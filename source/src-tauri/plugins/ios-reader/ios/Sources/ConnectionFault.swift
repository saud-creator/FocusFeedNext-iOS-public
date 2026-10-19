import Foundation

enum ConnectionFault {
    static func loginMessage(_ code: String, arabic: Bool) -> String {
        switch code {
        case "rate_limited": return arabic ? "فرض X حدًا مؤقتًا للطلبات. انتظر قبل إعادة التحقق؛ تكرار المحاولة لا يزيل الحد." : "X has temporarily limited requests. Wait before checking again; repeated attempts do not remove the limit."
        case "account_challenge": return arabic ? "يطلب X خطوة تحقق إضافية. ارجع إلى صفحة X وأكملها ثم اضغط متابعة." : "X requires another account verification step. Return to X, complete it, then tap Continue."
        case "transport_initialization": return arabic ? "تعذر تجهيز اتصال آمن داخل التطبيق. حاول تسجيل الدخول مجددًا." : "The app could not prepare a secure connection. Please retry sign-in."
        case "session_storage": return arabic ? "تعذر حفظ الجلسة بأمان. تم الاحتفاظ بجلسة الحساب السابقة." : "The session could not be saved securely. Your previous session has been retained."
        case "authentication_expired": return arabic ? "لم يقبل X هذه الجلسة. أكمل تسجيل الدخول وأي خطوات تحقق مطلوبة ثم حاول مجددًا." : "X did not accept this session. Complete sign-in and any account verification steps, then retry."
        case "timeout": return arabic ? "استغرق الاتصال وقتًا طويلًا. حاول مجددًا." : "The connection took too long. Try again."
        case "transaction_bootstrap": return arabic ? "تعذر قراءة بيانات اتصال X. حاول مجددًا أو حدّث التطبيق." : "X connection metadata could not be read. Retry or update the app."
        case "provider_rejection": return arabic ? "رفض X طلب التحقق من الحساب. حاول مجددًا لاحقًا." : "X refused the account verification request. Try again later."
        case "unsupported_response": return arabic ? "أعاد X بيانات حساب غير متوقعة. حاول مجددًا أو حدّث التطبيق." : "X returned unexpected account data. Retry or update the app."
        default: return arabic ? "تعذر الوصول إلى X. تحقق من اتصال الإنترنت ثم حاول مجددًا." : "X could not be reached. Check your internet connection, then retry."
        }
    }
    static func transport(stage: String, id: String? = nil, error: Error? = nil) -> [String: Any] {
        var result = value("transport_initialization", stage, id: id)
        if let error = error as NSError? {
            var fault = result["fault"] as! [String: Any]
            // Never include userInfo, URLs, descriptions, cookies or provider text.
            fault["nativeErrorCode"] = error.code
            fault["nativeErrorDomain"] = error.domain == NSURLErrorDomain ? "url" : error.domain == "WKErrorDomain" ? "webkit" : "other"
            result["fault"] = fault
        }
        return result
    }
    static func value(_ code: String, _ stage: String, id: String? = nil, retryable: Bool = true, status: Int? = nil) -> [String: Any] {
        ["fault": ["code": code, "stage": stage, "requestId": id as Any? ?? NSNull(),
                   "retryable": retryable, "httpStatus": status as Any? ?? NSNull()]]
    }
    // Only our fixed messages enter this adapter. No exception descriptions are forwarded.
    static func fromMessage(_ message: String, id: String? = nil) -> [String: Any] {
        if message.contains("Keychain") || message.contains("storage") || message.contains("migrated") { return value("session_storage", "storage", id: id) }
        if message.contains("cancelled") || message.contains("no longer") || message.contains("background") { return value("cancelled", "queue", id: id, retryable: false) }
        if message.contains("too long") { return value("timeout", "provider", id: id) }
        if message.contains("unreadable") || message.contains("Unsupported") { return value("unsupported_response", "bridge", id: id, retryable: false) }
        if message.contains("transport") || message.contains("Transport") { return value("transport_initialization", "transport", id: id) }
        if message.contains("reached") { return value("network_failure", "provider", id: id) }
        return value("bridge_failure", "bridge", id: id)
    }
}
