import Darwin

/// A point-in-time process measurement, separate from estimated model payloads
/// and decoded-image cache cost. It is not peak memory or a device comparison.
enum NativeProcessMemory {
    static func snapshot() -> [String: Any] {
        var info = mach_task_basic_info_data_t()
        let capacity = MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<integer_t>.size
        var count = mach_msg_type_number_t(capacity)
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) { words in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), words, &count)
            }
        }
        let measurement = "MACH_TASK_BASIC_INFO.resident_size"
        guard status == KERN_SUCCESS else {
            return ["measurement":measurement,"available":false,"kernelStatus":Int(status)]
        }
        return ["measurement":measurement,"available":true,"residentBytes":UInt64(info.resident_size)]
    }
}
