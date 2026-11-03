# ADR 0012: Firmware updates over HTTPS (collar pulls, mTLS)

- Status: Accepted
- Date: 2026-11-02

## Context

CLAUDE.md said not to implement OTA: spec V3 only proposes `command/firmware_update` over MQTT.
The owner asked for it anyway: a separate dashboard tab where an admin uploads a firmware file
with its version, and an API the collar calls with its own version to learn whether it should
update and where to download the file.

An MQTT push (`command/firmware_update` with a URL) isn't needed for that, and the collar can't
download a file over MQTT anyway. So the collar pulls over HTTPS and the MQTT side is
unchanged. The owner chose to authenticate collars with client certificates issued by a CA.

## Decision

- **Releases.** An admin uploads `version` (SemVer, the same rule as
  `status/system.firmware_version`) plus the file (max 32 MiB) from the **Firmware** tab. The
  Worker stores the file in the private Supabase Storage bucket `firmware` at
  `{version}/{file name}`, and a row in `firmware_releases` with its size and SHA-256. Versions
  are unique. **At most one release is active**: the one offered to collars. The admin can
  switch it, stop offering any release, or delete a release (row + file).
- **Update rule: any difference.** A collar gets the active release when its version is not
  equal to it, so making an older release active is a rollback. No version ordering is needed.
- **Collar API** (`packages/contracts/src/firmware.ts` has the Zod schemas):
  - `GET /api/firmware/check?device_id=collar-01&version=1.0.0` →
    `{update: false, version: <active or null>}` or
    `{update: true, version, size_bytes, sha256, download_url}`.
  - `GET /api/firmware/latest` (`device_id` optional) → the active release without a version
    comparison: `{version, size_bytes, sha256, uploaded_at, download_url}`, or
    `{version: null}` when none is active.
  - `GET /api/firmware/download/{version}?device_id=…` streams the file
    (`application/octet-stream`, `X-Firmware-Version`, `X-Firmware-SHA256`), passing `Range`
    through so a collar can resume. The Worker fetches it from Storage with a 60 s signed URL,
    so the collar talks to one host only.
  - The collar must verify the SHA-256 before flashing.
- **Download state per collar** (migration `20261103100000_firmware_download_state.sql`): when an
  identified collar downloads, the Worker sets `devices.firmware_download_state = downloading`
  (with `firmware_download_version` and `_at`), then `downloaded` once the file's last byte has
  been streamed (a resumed `Range` download counts from its start offset; an aborted one stays
  `downloading`). The Collars view shows downloading → downloaded, waiting to install → up to
  date when `status/system.firmware_version` reports the downloaded version. Local downloads
  without `device_id` aren't recorded.
- **Collar identity: mTLS client certificates.** Each collar holds a certificate signed by our CA,
  with **subject CN = device_id**. Cloudflare verifies it on the custom hostname and reports the
  result in `request.cf.tlsClientAuth`. The Worker (`src/firmware/clientCert.ts`) accepts only
  `certPresented = 1`, `certVerified = SUCCESS`, `certRevoked = 0`, and a CN that is a valid
  device id and matches `device_id` when the request names one. The device must also already
  exist in `devices`, meaning it has published over MQTT before (rule 4). Refusals are `401`
  (`client_certificate_required` / `_invalid` / `_no_device`, `device_mismatch`) and `403`
  (`unknown_device`).
- **Local development** (`LIVE_VIEW_UNAUTHENTICATED=true` on localhost, ADR 0004) has no mTLS,
  so it trusts `device_id` from the query instead. `latest` and `download` also work without
  one there; deployed, the client certificate is always required.
- **Dashboard API** (admin only, `403 forbidden` for other users):
  `GET/POST /api/firmware/releases`, `DELETE /api/firmware/releases/{id}`,
  `PUT /api/firmware/active {id | null}`. Uploads, activations and deletions are logged at `warn`
  with the username. The `audit_log` table from rule 9 doesn't exist yet; these log lines stand
  in for it until it does.
- Migration `20261102100000_firmware_releases.sql`: table with RLS (admins read), the
  `activate_firmware(id)` function (switches the active release in one transaction, service role
  only), and the bucket with no storage policies (Worker only).

## Setup (Cloudflare)

mTLS works only on a **custom domain** in a Cloudflare zone, not on `*.workers.dev`.

1. Add a custom domain to the Worker, e.g. `api.example.com`.
2. Issue collar certificates. Either use SSL/TLS → Client Certificates → Create (a
   Cloudflare-managed CA, one certificate per collar with CN = device_id), or upload our own CA
   through the mTLS certificates API and associate it with the hostname.
3. Enable mTLS for the hostname (SSL/TLS → Client Certificates → Hosts).
4. Optional defence in depth: a WAF custom rule that blocks
   `starts_with(http.request.uri.path, "/api/firmware/check") or
   starts_with(http.request.uri.path, "/api/firmware/latest") or
   starts_with(http.request.uri.path, "/api/firmware/download")` when
   `not cf.tls_client_auth.cert_verified`. The Worker checks the certificate itself either way.
5. Revoke a lost collar's certificate in Cloudflare; the Worker then refuses it
   (`certRevoked = 1`).

## Consequences

- Firmware files count against the Supabase free plan's 1 GB of storage. Delete old releases.
- A collar that has never connected over MQTT can't update until it has published once.
- `command/firmware_update` over MQTT is still not implemented. If the firmware team wants a
  push ("check now"), it can be a command that only triggers this same check.
- Open questions for the firmware team: the check interval (e.g. on boot and every 24 h), how
  certificates are provisioned on the collar, and whether the collar needs `Range` support.
