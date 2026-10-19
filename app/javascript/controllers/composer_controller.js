import { Controller } from "@hotwired/stimulus"

// Clears the composer once the message was accepted, so a morph refresh never brings the sent text back.
export default class extends Controller {
  reset(event) {
    if (event.detail.success) this.element.reset()
  }
}
