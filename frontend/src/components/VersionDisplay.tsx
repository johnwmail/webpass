import { useState, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { VERSION as FRONTEND_VERSION, COMMIT as FRONTEND_COMMIT, BUILD_TIME as FRONTEND_BUILD_TIME } from '../lib/version';

export function VersionDisplay() {
  const [backendVersion, setBackendVersion] = useState<{ version: string; commit: string; build_time: string } | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);

  useEffect(() => {
    if (session.api) {
      session.api.fetchVersion()
        .then(setBackendVersion)
        .catch((err) => {
          console.error('Version fetch error:', err);
          setVersionError(err.message || 'Failed to fetch version');
        });
    }
  }, []);

  return (
    <div class="settings-section">
      <h3>Version</h3>
      <div class="version-details">
        <div class="version-block">
          <div class="version-label">Frontend</div>
          <div class="version-row">
            <span class="version-meta-label">Version:</span>
            <span class="version-value">{FRONTEND_VERSION}</span>
          </div>
          <div class="version-row">
            <span class="version-meta-label">Commit:</span>
            <span class="version-value">{FRONTEND_COMMIT}</span>
          </div>
          <div class="version-row">
            <span class="version-meta-label">Built:</span>
            <span class="version-value">{FRONTEND_BUILD_TIME}</span>
          </div>
        </div>
        {backendVersion ? (
          <div class="version-block">
            <div class="version-label">Backend</div>
            <div class="version-row">
              <span class="version-meta-label">Version:</span>
              <span class="version-value">{backendVersion.version}</span>
            </div>
            <div class="version-row">
              <span class="version-meta-label">Commit:</span>
              <span class="version-value">{backendVersion.commit}</span>
            </div>
            <div class="version-row">
              <span class="version-meta-label">Built:</span>
              <span class="version-value">{backendVersion.build_time}</span>
            </div>
            {backendVersion.commit !== FRONTEND_COMMIT && (
              <div class="version-warning" title="Commit hashes differ">⚠️ Versions differ</div>
            )}
          </div>
        ) : versionError ? (
          <div class="version-block">
            <div class="version-label">Backend</div>
            <div class="version-row">
              <span class="version-meta-label">Version:</span>
              <span class="version-value" style="color: var(--text-muted);">Unavailable</span>
            </div>
            <div class="version-error" style="margin-top: 8px; color: var(--danger); font-size: 12px;">
              ⚠️ {versionError}
            </div>
          </div>
        ) : (
          <div class="version-block">
            <div class="version-label">Backend</div>
            <div class="version-row">
              <span class="version-meta-label">Version:</span>
              <span class="version-value" style="color: var(--text-muted);">Loading...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
