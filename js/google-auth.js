// Explicit, user-initiated authorization. Tokens never enter Drive snapshots.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
export class GoogleAuth {
  constructor({
    clientId = "",
    scopes = DRIVE_SCOPE,
    onChange = () => {},
    storage = sessionStorage,
  }) {
    Object.assign(this, { clientId, scopes, onChange, storage });
    this.token = null;
    this.expiresAt = 0;
    try {
      const saved = JSON.parse(storage.getItem("campus_google_token_v1"));
      if (saved) this.accept(saved.token, saved.expiresAt, false);
    } catch {
      /* Reconnect explicitly. */
    }
  }
  getToken() {
    return this.token && Date.now() < this.expiresAt - 60000
      ? this.token
      : null;
  }
  accept(token, expiresAt, notify = true) {
    if (
      typeof token !== "string" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      return;
    this.token = token;
    this.expiresAt = expiresAt;
    this.storage.setItem(
      "campus_google_token_v1",
      JSON.stringify({ token, expiresAt }),
    );
    if (notify) this.onChange();
  }
  disconnect() {
    this.token = null;
    this.expiresAt = 0;
    this.storage.removeItem("campus_google_token_v1");
    this.onChange();
  }
  connect() {
    if (!this.clientId.trim())
      throw Error(
        "Enter the Google OAuth client ID in Settings first. Use the same ID in both apps.",
      );
    if (!globalThis.google?.accounts?.oauth2)
      throw Error(
        "Google sign-in is still loading or unavailable offline. Try again when connected.",
      );
    const client = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId.trim(),
      scope: this.scopes,
      include_granted_scopes: true,
      callback: (response) => {
        if (response.error || !response.access_token) {
          this.onChange(
            response.error_description ||
              response.error ||
              "Google connection was not completed.",
          );
          return;
        }
        this.accept(
          response.access_token,
          Date.now() + Number(response.expires_in || 3600) * 1000,
        );
      },
      error_callback: () =>
        this.onChange(
          "Google connection was not completed. Local data is safe.",
        ),
    });
    client.requestAccessToken({ prompt: "" });
  }
}
