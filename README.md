# Nikhil Kumar - personal portfolio

A dependency-free, static portfolio. Plain HTML, CSS, and a small progressive-enhancement script; no build step, package installation, trackers, cookies, or backend.

## Run locally

From this folder:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/`. Stop the server with Ctrl+C.

## Site files

| File | Purpose |
| --- | --- |
| `index.html` | Home, selected work, experience, about, Topmate mentorship, contact, resume downloads |
| `projects/billing-system.html` | Consumption Billing System |
| `projects/reporting.html` | Consumption Reporting |
| `projects/free-trials.html` | Free Trials and Adoption |
| `projects/migration-assistant.html` | DLP Migration Assistant |
| `assets/styles.css` | Shared responsive styles and print layout |
| `assets/site.js` | Keyboard-accessible mobile navigation and progressive testimonial controls |
| `assets/favicon.svg` | Original abstract, non-letter icon |
| `assets/social-card.svg` | Original 1200 x 630 social card |
| `assets/social-card.png` | Browser-rasterized 1200 x 630 social sharing image |
| `assets/resume/` | Approved, unmodified PDF and Word resume downloads |
| `assets/images/` | User-approved portraits and Times Square image, optimized as responsive WebP and JPEG copies |
| `.nojekyll` | Serve the site as plain static files on GitHub Pages |
| `sitemap.xml` | The five canonical public page URLs |

## Editing

- Edit page content directly in HTML. Important content and navigation remain available without JavaScript.
- All pages share `assets/styles.css` and `assets/site.js`. Color and font variables are at the top of the stylesheet; all fonts are system fonts.
- Header and footer markup is intentionally static. Apply navigation changes to all five pages.
- Keep links and asset paths relative so both a domain root and a project path work. Case studies use `../` for parent assets.
- Replace resume copies in `assets/resume/` while keeping the filenames, or update the two download links in `index.html`.
- Keep project claims scoped: reporting API capabilities are platform context, free-trial outcomes describe consumption rather than paid conversion, and migration backend work was co-owned.
- The hero role is Software Engineer II at Microsoft. The approved downloadable resume files are distributed as supplied.
- Navigation uses the full name. The favicon and social image do not use an initials monogram.

## Portraits

The hero uses the approved indoor portrait; About uses the approved outdoor photo beside a Microsoft sign. No location or date is inferred from either image.

- Indoor WebP variants: 480, 768, and 1080 pixels wide. Outdoor variants: 480, 768, and 960 pixels wide. Each also has a 768-pixel JPEG fallback.
- HTML `picture`, `srcset`, `sizes`, and explicit dimensions provide responsive selection and reserve space before loading. The hero image is prioritized; the About image is lazy-loaded.
- Public copies were resized from RGB pixel data without EXIF, GPS, or XMP metadata. The outdoor crop excludes the hanging ID badge. Faces were not altered, and original attachments were left intact outside the site.
- Keep future source originals outside the published folder, and strip metadata from replacement public copies.

The Times Square highlight uses the separately supplied billboard image in 480-, 768-, and 1092-pixel WebP variants plus a 768-pixel JPEG fallback. These copies are also metadata-free. The linked [original LinkedIn post](https://www.linkedin.com/feed/update/urn:li:activity:7316494661861183488/) confirms the feature date (9 April 2025) and Topmate Quarter 1 Game Changers context. The image and text both link to that exact post; no unrelated rankings or outcomes are inferred.

## Mentorship content

The mentorship section is a dated, static snapshot of [Nikhil's Topmate profile](https://topmate.io/nikhil_kr), checked on 13 September 2026: 5/5 from 92 ratings, 173 bookings, 85 testimonials, and nine displayed earned badges.

- "4+ years on Topmate" refers to the platform join date, 24 March 2022, not a separate claim of continuous mentoring duration. It is distinct from software engineering experience.
- The carousel contains ten distinct, short, attributed excerpts of actual public reviews, with their original review year. Year-only attribution avoids timezone-dependent month boundaries. Do not paraphrase inside quotation marks or imply guaranteed job outcomes.
- Reviews use native horizontal scrolling and CSS scroll snap. Touch/trackpad scrolling works without JavaScript. JavaScript adds previous/next controls, a live visible-range counter, and Left/Right/Home/End keys when the scroll region has focus. There is no autoplay; reduced-motion preferences disable smooth scrolling.
- When changing the selection, update the ten-voice introduction and each slide's accessible index/count. Keep each review distinct; never duplicate slides to increase the apparent count. The JavaScript counter derives its total from the actual cards.
- Badge names are platform-awarded distinctions, not current ranking guarantees or independent certifications.
- Update counts and the visible snapshot date together when refreshing the source. Ratings and written testimonials are different counts; bookings are not a unique-mentee count.
- Booking links go directly to the corresponding public Topmate services. Current availability and prices remain on Topmate; the site does not take bookings or payments.
- No Topmate widgets, scripts, remote images, or tracking code are embedded.

## Publishing

The configured deployment target is [cracker-jack/nikhil-kumar-portfolio](https://github.com/cracker-jack/nikhil-kumar-portfolio), using GitHub Pages from the `main` branch and repository root. No build step is needed.

The public base URL is:

`https://cracker-jack.github.io/nikhil-kumar-portfolio/`

All five pages have matching absolute canonical and `og:url` values. Their `og:image` points to the public `assets/social-card.png`; Person structured data points to the public home URL. `sitemap.xml` lists the same five canonical URLs.

If the domain or repository name changes, update those metadata values and the sitemap together. Navigation, stylesheets, scripts, favicon, and downloads use relative paths and also work at a domain root.

GitHub authentication, repository changes, and publishing are managed separately. These configured URLs do not by themselves mean the site has been deployed.

Only website files belong in the published folder. Keep browser captures, raw source documents, credentials, generators, and local validation artifacts outside it.
