/** Belt-and-suspenders defense against a real secret ever reaching a printed
 * or written output — an exact-string replace of the *resolved* credential
 * values with a placeholder, applied at every actual output boundary
 * (`cli.ts`'s printed failure report and the generated spec string) right
 * before they're printed or written. The rest of this feature's design
 * (never mutating an action object with a substituted value, `generateSpec`
 * never even receiving real credentials) should already make a leak
 * impossible — this exists as a second, independent layer in case a future
 * change reintroduces one somewhere this design didn't anticipate. Cheap
 * enough that there's no real reason not to have both. */
export function redactSecrets(text: string, secrets: (string | undefined)[]): string {
  let result = text
  for (const secret of secrets) {
    if (!secret) continue
    result = result.split(secret).join('***REDACTED***')
  }
  return result
}
