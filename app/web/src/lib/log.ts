/** A structured log line for the browser console: one JSON object with the event name and its fields. */
export const log = (event: string, fields: Record<string, unknown>) => {
  console.info(JSON.stringify({ event, ...fields }))
}
