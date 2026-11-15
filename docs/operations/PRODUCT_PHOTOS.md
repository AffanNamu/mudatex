# Product and department photos

Staff add pictures from the console; the shop shows them. Nothing outside Mudatex is needed (no image service to sign up for).

## Adding pictures (Online store → Products sold online → Edit)
- **Choose pictures**: pick one or several from the phone's camera or gallery, or from the computer. Each photo is **shrunk on the
  device** (longest side 1600 pixels, saved as WebP, or JPEG where the browser cannot make WebP) before it is sent, so a 6 MB phone
  photo uploads as a few hundred kilobytes, even on mobile data.
- The **first picture is the main one**. Use the arrows to reorder and *Remove* to take one off (up to 12 per product).
- You can still **paste a picture link** (https) if the photo already lives elsewhere.
- Departments take one picture each (*Departments → New department*).
- Press **Save listing** to publish the change. A picture that is uploaded but never saved is cleared out after two days.

## Good photos for fabric
Daylight, plain background, the cloth flat and then a close-up of the weave; a metre laid out for scale. Square or 4:3 crops show best on
the product cards. One photo per colour is more useful than many of the same.

## How it works and its limits
- Photos are stored in the database (so backups include them) and served by the API at `/images/<id>` with a one-year cache, so each
  picture is fetched once per visitor. Only JPEG, PNG and WebP are accepted, checked by their real content (not their name); 2 MB at most.
- Each company may keep **300 MB** of photos by default (`IMAGE_QUOTA_MB`). That is roughly 2,000 photos at about 150 KB. Supabase's free
  database is 500 MB in total, so for a large catalogue use the Pro plan or move photos to a storage service later.
- Set `PUBLIC_API_URL` (for example `https://mudatex-api.vercel.app`) on the API so photo links are built with the public address.
  Without it the address the staff member's browser used is taken, which is right in normal use.
- The same photo uploaded twice is stored once.
