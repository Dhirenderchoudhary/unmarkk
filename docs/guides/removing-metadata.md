# How to remove metadata

A practical guide. Start with whatever you actually have.

- [A photo before posting it](#a-photo-before-posting-it)
- [A document before sending it](#a-document-before-sending-it)
- [A PDF](#a-pdf)
- [A whole folder](#a-whole-folder)
- [A website](#a-website)
- [Without installing anything](#without-installing-anything)
- [In a script](#in-a-script)
- [What to check afterwards](#what-to-check-afterwards)

---

## A photo before posting it

```bash
unmark inspect holiday.jpg
```

```
holiday.jpg  image/jpeg  found
  location, device identity, timestamps
  identifying metadata: location (GPS coordinates), device identity (make, model
  or serial number), capture or edit timestamps

  [confirmed] Exif block with 6 identifying tags: Artist, DateTime,
              DateTimeOriginal, GPSInfo, Make, Model (offset 2)
```

That file knows where it was taken, on what, and when. Remove it:

```bash
unmark clean holiday.jpg
# -> holiday.cleaned.jpg
```

The pixels are untouched — only metadata segments are dropped, so the image
decodes to exactly the same picture. It is lossless in the strict sense: no
re-encoding, no second JPEG generation.

**Keeping your camera settings.** If you want aperture and ISO preserved for a
photography workflow and only want provenance structures gone:

```bash
unmark clean holiday.jpg --keep-non-ai-metadata
```

Be aware that keeps GPS too. For posting publicly, the default is what you want.

---

## A document before sending it

```bash
unmark inspect proposal.docx
```

A Word file typically knows your name, who last saved it, your employer, how
many times it was revised and how long you spent on it:

```
  [confirmed] docProps/core.xml <dc:creator> names "Dhirender Choudhary"
  [confirmed] docProps/app.xml <Company> is "Acme Holdings"
  [confirmed] document properties record creation and modification times
```

```bash
unmark clean proposal.docx
```

The document body is byte-identical afterwards. Only the properties are
cleared, and references to removed parts are repaired so Word does not offer to
"repair" the file when it opens.

**In place, keeping a backup:**

```bash
unmark clean proposal.docx --in-place    # writes proposal.docx.bak first
```

---

## A PDF

```bash
unmark clean report.pdf
```

Worth knowing what this does differently. The usual advice is `exiftool -all=`,
which writes an **incremental update**: it drops `/Info` from the trailer, but
the original bytes stay in the file and `exiftool` itself can restore them with
`-PDF-update:all=`. A PDF cleaned that way still contains your name.

`unmark` rebuilds the document from its object graph. Removed objects are
absent from the output, not merely unreferenced. It also expands object streams
first, because in PDF 1.5 and later the Info dictionary usually lives compressed
inside one — a cleaner that skips that step removes nothing at all.

Check it yourself:

```bash
strings report.cleaned.pdf | grep -i "your name"    # nothing
```

**Encrypted PDFs are refused.** Without the password the objects cannot be
re-serialised, so the tool stops instead of producing something broken.

---

## A whole folder

```bash
unmark scan ~/Pictures --quiet
```

```
! IMG_2231.jpg · jpeg   location, device identity, timestamps
! IMG_2244.jpg · jpeg   location, device identity, timestamps
! scan-01.pdf  · pdf    author identity, timestamps

312 scanned · 3 need attention
  by format: jpeg 280, png 29, pdf 3
  findings: confirmed 14, informational 22
  2 with location, 2 with device identity, 1 naming a person
```

Ranked worst-first, so the top of the list is where to look. Then clean what
matters:

```bash
unmark clean ~/Pictures/IMG_2231.jpg --in-place
```

There is deliberately no "clean everything recursively" flag. Bulk-rewriting a
photo library in one command is the kind of thing people regret, and `scan`
plus a loop is explicit about what is happening:

```bash
unmark scan ~/Pictures --quiet --json \
  | jq -r '.items[] | select(.actionable) | .name' \
  | while read -r f; do unmark clean "$f" --in-place; done
```

---

## A website

```bash
unmark audit-site https://example.com/sitemap.xml --quiet
```

Fetches the URLs in the sitemap and inspects what the server returns. Useful
when a site has accumulated uploads from many people over years and you want to
know how many still carry GPS.

This is the only command that touches the network. It issues GETs only, refuses
private and loopback addresses, re-validates every redirect, and caps response
size, request count and time.

```bash
unmark audit-site https://example.com/sitemap.xml \
  --limit 500 --concurrency 8 --json > audit.json
```

A remote audit sees what the server sends. Download an interesting asset and
run `unmark inspect` on it for the full picture.

---

## Without installing anything

**In your browser** — open the web app, drop files in. Everything runs in the
tab; the page sets `connect-src 'none'` so the browser blocks any upload it
could attempt. Watch the Network tab while you do it.

**One-off from a terminal:**

```bash
npx @unmarkk/cli inspect photo.jpg
```

---

## In a script

`inspect` and `scan` exit `1` when something needs attention, `0` when nothing
does:

```bash
if ! unmark inspect "$file" >/dev/null; then
  unmark clean "$file" --in-place
fi
```

As a CI check on a repository where images get committed:

```yaml
- run: npx @unmarkk/cli scan . --quiet
```

Machine-readable output:

```bash
unmark inspect photo.jpg --json | jq '.report.privacy'
```

```json
{
  "hasLocation": true,
  "hasDeviceIdentity": true,
  "hasAuthorIdentity": false,
  "hasTimestamps": true
}
```

Match on `finding.code`, which is stable. `finding.message` is written for
people and changes between releases.

---

## What to check afterwards

**Re-inspect.** The clean already does this and reports anything left, but
confirming independently costs nothing:

```bash
unmark inspect photo.cleaned.jpg
```

**Read the actions.** `unmark clean` lists what it removed. If that list is
shorter than you expected, the file may not have contained what you assumed.

**Watch for `degraded`.** It means the file could not be fully rebuilt and the
clean is best-effort. The output is safer than the input but not provably
complete.

**Remember what is still there.** Metadata is one channel. After a successful
clean, the file still has its contents, its size, and — for a photograph —
everything visible in the frame. A picture of your street with the GPS removed
is still a picture of your street.

---

## Related

- [Text and invisible characters](text.md) — the other half of the tool
- [Format reference](../formats.md) — exactly what is removed and what is kept
- [Limits](../../README.md#limits) — what this cannot do
