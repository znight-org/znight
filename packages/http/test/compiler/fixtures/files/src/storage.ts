// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import { fileURLToPath } from 'node:url'

/** Directory of the downloadable documents (`root` of HttpResponse.file()). */
export const DOCUMENTS_DIR: string = fileURLToPath(new URL('../documents', import.meta.url))
