-- Per-collar firmware download state (ADR 0012).
--
-- The Worker sets `downloading` when a collar starts `GET /api/firmware/download/{version}` and
-- `downloaded` once the last byte of the file has been streamed to it (resumed Range downloads
-- included). The collar has installed the update once `firmware_version` (from status/system)
-- equals the downloaded version.

alter table public.devices
  add column firmware_download_version text check (length(firmware_download_version) <= 64),
  add column firmware_download_state text
    check (firmware_download_state in ('downloading', 'downloaded')),
  add column firmware_download_at timestamptz;

comment on column public.devices.firmware_download_state is
  'Last firmware download: downloading | downloaded (ADR 0012). Written by the Worker only.';
