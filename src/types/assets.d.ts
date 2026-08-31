/**
 * Vite's client types cover asset imports; declaring the stylesheet here keeps
 * the renderer typecheck self-contained and avoids pulling DOM globals we do not
 * want (`import.meta.env` is unused in this app).
 */
declare module '*.css'
