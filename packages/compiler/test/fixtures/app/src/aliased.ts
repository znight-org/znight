class Internal {}
class NotExported {}
export class Exported {}
export interface Shape {}

export { Internal as Public }
export default Exported
