/**
 * Decides when the arena scene may repaint.
 *
 * A repaint rebuilds the whole display list, so one that lands mid-drag
 * destroys the token under the pointer and `dragend` never fires. The gate
 * holds repaints back while a drag is in flight and replays the one it owes
 * when the drag ends — and treats a resize as the one event that ends a drag
 * on the scene's behalf, since a resize has to repaint no matter what.
 */
export class RepaintGate {
  private dragging = false;
  private owed = false;

  get isDragging(): boolean {
    return this.dragging;
  }

  beginDrag(): void {
    this.dragging = true;
  }

  /** A state update arrived. Returns whether the scene should paint now. */
  requestPaint(): boolean {
    if (this.dragging) {
      this.owed = true;
      return false;
    }
    return true;
  }

  /** The drag finished. Returns whether a repaint was held back during it. */
  endDrag(): boolean {
    this.dragging = false;
    const owed = this.owed;
    this.owed = false;
    return owed;
  }

  /**
   * The canvas changed size, so the scene is about to repaint regardless.
   * That repaint destroys any token being dragged, so the drag is abandoned
   * here — leaving it open would park every later update in `owed` and freeze
   * the floor until the next resize.
   */
  resize(): void {
    this.dragging = false;
    this.owed = false;
  }
}
