/**
 * Container sandbox management.
 *
 * Manages warm Docker containers per thread. Each container runs with a
 * read-only rootfs, all Linux capabilities dropped, and no network access
 * unless explicitly granted by persona policy.
 * Secrets are delivered via stdin JSON at spawn time, never written to disk.
 */

export {};
