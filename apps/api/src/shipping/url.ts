/** The company's own tracking page for a parcel, from the carrier's template (with {ref} where the number goes). */
export function trackingUrl(template: string | null, ref: string | null): string | null {
  return template && ref ? template.replace('{ref}', encodeURIComponent(ref)) : null;
}
