/**
 * Inter-process communication (IPC) subsystem.
 *
 * Implements file-based atomic IPC between the daemon and sandboxed containers,
 * and between talonctl and talond. Uses write-file-atomic for crash-safe writes
 * and a configurable poll interval (default 500 ms).
 */

export {};
