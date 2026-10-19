import { Controller } from "@hotwired/stimulus"

// Refreshes the page every `interval` ms while attached. Only the ChatGPT sign-in page uses it: the sidecar's
// loopback listener can finish a login without the user pasting anything, and logins send no change events.
export default class extends Controller {
  static values = { interval: { type: Number, default: 3000 } }

  connect() {
    this.timer = setInterval(() => Turbo.visit(window.location.href, { action: "replace" }), this.intervalValue)
  }

  disconnect() {
    clearInterval(this.timer)
  }
}
