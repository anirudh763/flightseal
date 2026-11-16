# Social preview card

`og-card.svg` is the editable 1200×630 source. The PNG is generated with macOS ImageIO using:

```sh
sips -s format png newweb/public/og-card.svg --out newweb/public/og-card.png
sips -g pixelWidth -g pixelHeight newweb/public/og-card.png
```

The preview is based on the bundled 800-record fixture and its bundled demonstration key. It is not a customer example, certification, or flight-origin claim.
