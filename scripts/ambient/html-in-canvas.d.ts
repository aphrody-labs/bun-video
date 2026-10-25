// Script-level copy of the HTML-in-canvas globals declared in remotion/core/src/HtmlInCanvas.tsx (lines 47-234).
// The rolled-up public surface cannot carry a module's declare-global block, so the ambient owner supplies it.
interface DrawElementImageOptions {
  preserveElementGeometry?: boolean;
}

interface WebGLCopyElementImageConfig {
  sx?: GLfloat;
  sy?: GLfloat;
  swidth?: GLfloat;
  sheight?: GLfloat;
  width?: GLsizei;
  height?: GLsizei;
}

interface UpdateElementGeometryOptions {
  preserveHitTestOrder?: boolean;
  clip?: DOMRectInit;
  canvasTransform?: DOMMatrixInit;
}

interface ElementImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

interface CanvasRenderingContext2D {
  drawElementImage(element: Element | ElementImage, dx: number, dy: number, options?: DrawElementImageOptions): void;
  drawElementImage(
    element: Element | ElementImage,
    dx: number,
    dy: number,
    dwidth: number,
    dheight: number,
    options?: DrawElementImageOptions,
  ): void;
  drawElementImage(
    element: Element | ElementImage,
    sx: number,
    sy: number,
    swidth: number,
    sheight: number,
    dx: number,
    dy: number,
    options?: DrawElementImageOptions,
  ): void;
  drawElementImage(
    element: Element | ElementImage,
    sx: number,
    sy: number,
    swidth: number,
    sheight: number,
    dx: number,
    dy: number,
    dwidth: number,
    dheight: number,
    options?: DrawElementImageOptions,
  ): void;
}

interface OffscreenCanvasRenderingContext2D {
  drawElementImage(element: Element | ElementImage, dx: number, dy: number, options?: DrawElementImageOptions): void;
  drawElementImage(
    element: Element | ElementImage,
    dx: number,
    dy: number,
    dwidth: number,
    dheight: number,
    options?: DrawElementImageOptions,
  ): void;
  drawElementImage(
    element: Element | ElementImage,
    sx: number,
    sy: number,
    swidth: number,
    sheight: number,
    dx: number,
    dy: number,
    options?: DrawElementImageOptions,
  ): void;
  drawElementImage(
    element: Element | ElementImage,
    sx: number,
    sy: number,
    swidth: number,
    sheight: number,
    dx: number,
    dy: number,
    dwidth: number,
    dheight: number,
    options?: DrawElementImageOptions,
  ): void;
}

// Augmenting the base interface applies to both WebGL1 and WebGL2.
interface WebGLRenderingContextBase {
  texElementSubImage2D(
    target: GLenum,
    level: GLint,
    xoffset: GLint,
    yoffset: GLint,
    element: Element | ElementImage,
    config?: WebGLCopyElementImageConfig,
  ): void;

  // Older Chromium builds expose texElementImage2D during the migration.
  texElementImage2D(
    target: GLenum,
    level: GLint,
    internalformat: GLint,
    format: GLenum,
    type: GLenum,
    element: Element | ElementImage,
  ): void;
  texElementImage2D(
    target: GLenum,
    level: GLint,
    internalformat: GLint,
    width: GLsizei,
    height: GLsizei,
    format: GLenum,
    type: GLenum,
    element: Element | ElementImage,
  ): void;
  texElementImage2D(
    target: GLenum,
    level: GLint,
    internalformat: GLint,
    sx: GLfloat,
    sy: GLfloat,
    swidth: GLfloat,
    sheight: GLfloat,
    format: GLenum,
    type: GLenum,
    element: Element | ElementImage,
  ): void;
  texElementImage2D(
    target: GLenum,
    level: GLint,
    internalformat: GLint,
    sx: GLfloat,
    sy: GLfloat,
    swidth: GLfloat,
    sheight: GLfloat,
    width: GLsizei,
    height: GLsizei,
    format: GLenum,
    type: GLenum,
    element: Element | ElementImage,
  ): void;
}

interface HTMLCanvasElementEventMap {
  paint: Event;
}

interface HTMLCanvasElement {
  content: string;
  layoutSubtree?: boolean;
  onpaint: ((this: HTMLCanvasElement, ev: Event) => unknown) | null;
  requestPaint?(): void;
  captureElementImage(element: Element): ElementImage;
  updateElementGeometry(element: Element | ElementImage, options?: UpdateElementGeometryOptions): void;
  clearElementGeometry(element: Element | ElementImage): void;
  getElementTransform(element: Element): DOMMatrix;
}

interface OffscreenCanvas {
  updateElementGeometry(element: Element | ElementImage, options?: UpdateElementGeometryOptions): void;
  clearElementGeometry(element: Element | ElementImage): void;
}
