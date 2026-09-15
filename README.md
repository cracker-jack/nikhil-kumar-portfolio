# Nikhil Kumar - personal portfolio

A dependency-free, static portfolio. Plain HTML, CSS, and progressive-enhancement scripts; no build step, package installation, trackers, cookies, or hosted backend.

## Run locally

From this folder:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/`. Stop the server with Ctrl+C.

## Site files

| File | Purpose |
| --- | --- |
| `index.html` | Home, selected work, experience, about, Topmate mentorship, LinkedIn recommendations, contact, resume downloads |
| `explore.html` | Alternative, photo-led visual portfolio with an interactive four-project gallery |
| `projects/billing-system.html` | Consumption Billing System |
| `projects/reporting.html` | Consumption Reporting |
| `projects/free-trials.html` | Free Trials and Adoption |
| `projects/migration-assistant.html` | DLP Migration Assistant |
| `assets/styles.css` | Shared responsive styles and print layout |
| `assets/visual.css` | Self-contained styles for the visual portfolio; does not restyle the classic pages |
| `assets/site.js` | Keyboard-accessible mobile navigation and shared progressive carousel controls |
| `assets/booking.js`, `assets/booking-slots.js` | Preferred date/time selection, review and hosted-payment handoff; not live calendar availability |
| `assets/favicon.svg` | Original abstract, non-letter icon |
| `assets/social-card.svg` | Original 1200 x 630 social card |
| `assets/social-card.png` | Browser-rasterized 1200 x 630 social sharing image |
| `assets/resume/` | Approved, unmodified PDF and Word resume downloads |
| `assets/images/` | User-approved portraits and Times Square image, optimized as responsive WebP and JPEG copies |
| `.nojekyll` | Serve the site as plain static files on GitHub Pages |
| `sitemap.xml` | The six canonical public page URLs |

## Editing

- Edit page content directly in HTML. Important content and navigation remain available without JavaScript.
- The five classic pages share `assets/styles.css`; the visual edition uses `assets/visual.css`. All six share `assets/site.js`. Color and font variables are at the top of each stylesheet; all fonts are system fonts.
- Header and footer markup is intentionally static. Apply shared navigation changes across the five classic pages and check the visual edition's separate navigation as well.
- Keep links and asset paths relative so both a domain root and a project path work. Case studies use `../` for parent assets.
- Replace resume copies in `assets/resume/` while keeping the filenames, or update the two download links in `index.html`.
- Keep project claims scoped: reporting API capabilities are platform context, free-trial outcomes describe consumption rather than paid conversion, and migration backend work was co-owned.
- The hero role is Software Engineer II at Microsoft. The approved downloadable resume files are distributed as supplied.
- Navigation uses the full name. The favicon and social image do not use an initials monogram.

## Visual portfolio

`explore.html` is a separate visual edition, linked from the classic homepage's hero. The classic homepage and four case studies remain available. Its original design takes cues from Apple's spacious, image-led product presentation without copying Apple artwork, branding, or page content.

- Large system-sans typography, mint photography, deep teal billing, blue reporting, warm apricot trials, and coral migration panels create a distinct visual rhythm.
- The project gallery uses native horizontal scrolling and scroll snap. Project selector links and every case study remain usable without JavaScript. Progressive controls add previous/next buttons, the current project state, a counter, and Left/Right/Home/End keyboard support on the focused gallery.
- `assets/site.js` shares carousel behavior between the classic Topmate reviews and the visual project gallery. New galleries use `data-carousel`, `data-carousel-track`, `data-carousel-slide`, `data-carousel-controls`, and `data-carousel-status`; selector links are optional `data-carousel-link` anchors to slide IDs. Existing testimonial classes remain supported.
- There is no autoplay or scroll hijacking. A single short portrait entrance and smooth gallery movement honor reduced-motion preferences; content is visible by default.
- The page reuses only the approved local portrait and Times Square variants, existing resume downloads, sourced career/project facts, and a complete user-supplied LinkedIn recommendation with its original date.
- This page loads `assets/visual.css` instead of the classic stylesheet. Keep its navigation compatible with the shared script when editing.

## Portraits

The hero uses the approved indoor portrait; About uses the approved outdoor photo beside a Microsoft sign. No location or date is inferred from either image.

- Indoor WebP variants: 480, 768, and 1080 pixels wide. Outdoor variants: 480, 768, and 960 pixels wide. Each also has a 768-pixel JPEG fallback.
- HTML `picture`, `srcset`, `sizes`, and explicit dimensions provide responsive selection and reserve space before loading. The hero image is prioritized; the About image is lazy-loaded.
- Public copies were resized from RGB pixel data without EXIF, GPS, or XMP metadata. The outdoor crop excludes the hanging ID badge. Faces were not altered, and original attachments were left intact outside the site.
- Keep future source originals outside the published folder, and strip metadata from replacement public copies.

The Times Square highlight uses the separately supplied billboard image in 480-, 768-, and 1092-pixel WebP variants plus a 768-pixel JPEG fallback. These copies are also metadata-free. The linked [original LinkedIn post](https://www.linkedin.com/feed/update/urn:li:activity:7316494661861183488/) confirms the feature date (9 April 2025) and Topmate Quarter 1 Game Changers context. The image and text both link to that exact post; no unrelated rankings or outcomes are inferred.

## Mentorship content

The Topmate portion of the mentorship section is a dated, static snapshot of [Nikhil's Topmate profile](https://topmate.io/nikhil_kr), checked on 13 September 2026: 5/5 from 92 ratings, 173 bookings, 85 testimonials, and nine displayed earned badges.

- "4+ years on Topmate" refers to the platform join date, 24 March 2022, not a separate claim of continuous mentoring duration. It is distinct from software engineering experience.
- The carousel contains ten distinct, short, attributed excerpts of actual public reviews, with their original review year. Year-only attribution avoids timezone-dependent month boundaries. Do not paraphrase inside quotation marks or imply guaranteed job outcomes.
- Reviews use native horizontal scrolling and CSS scroll snap. Touch/trackpad scrolling works without JavaScript. JavaScript adds previous/next controls, a live visible-range counter, and Left/Right/Home/End keys when the scroll region has focus. There is no autoplay; reduced-motion preferences disable smooth scrolling.
- When changing the selection, update the ten-voice introduction and each slide's accessible index/count. Keep each review distinct; never duplicate slides to increase the apparent count. The JavaScript counter derives its total from the actual cards.
- Badge names are platform-awarded distinctions, not current ranking guarantees or independent certifications.
- Update counts and the visible snapshot date together when refreshing the source. Ratings and written testimonials are different counts; bookings are not a unique-mentee count.
- The existing Topmate booking links still go directly to the corresponding services. Their availability and pricing remain on Topmate, separate from the direct-session option below.
- No Topmate widgets, scripts, remote images, or tracking code are embedded.

## Direct sessions and hosted payments

The classic homepage's `#direct-sessions` block lists the five user-approved session prices and durations. With JavaScript, it offers service/date/time selection, a review step, a prefilled email request and the user-supplied [Razorpay payment page](https://razorpay.me/@nikhilkumar7447). Without JavaScript, the original email-first/payment links remain available.

- The form collects a local session preference only. It does not submit a booking to a server, store personal information or query Google. The payment action is a plain outbound link, not an embedded gateway, API checkout, payment-verification service or automatic calendar integration. It needs no API credentials in the portfolio.
- The page tells customers to agree a slot by email first, then enter the listed fee and service name on Razorpay. Payment alone does not automatically reserve a slot or send a calendar invitation.
- Prices are mentorship INR 499 / 30 minutes, resume review INR 399 / 30 minutes, HLD and LLD mocks INR 999 each / 60 minutes, and coding/DSA mock INR 699 / 60 minutes. These are direct-session fees, not assertions about Topmate prices.
- Update the five service rows in `index.html` together when changing prices or durations. The picker reads those rows instead of maintaining a separate browser price list.
- The picker uses IST rather than the visitor's device timezone. It offers future-only, 30-minute-grid preferences during weekdays 16:00-23:00 and weekends 11:00-23:00, with every session finishing by 23:00. These are usual working hours, not checked calendar availability or reserved slots.
- Changing the selection clears the old review. Email/payment actions revalidate time before navigation. The Razorpay link opens in a new tab; the customer must manually enter the fee and paste the suggested note because the generic link does not transfer the selected date/time.
- The hosted page controls its payment methods and terms. Do not claim that this generic link enforces UPI-only checkout, fixes the amount, binds a payment to a session, or signals successful payment back to this website. Do not invent prefill parameters or treat a redirect as proof of payment.
- Browser modules use `.js` filenames for compatibility with static servers. No JavaScript or a failed module load leaves the email-first/payment fallback usable.
- Live calendar availability, automatic reservations, payment verification and calendar invitations are not part of this static release.

## LinkedIn recommendations

The `#recommendations` section contains seven complete recommendations from LinkedIn text supplied by Nikhil on 14 September 2026. Each includes the original recommendation date in a semantic `time` element. The section links to the supplied [received recommendations page](https://www.linkedin.com/in/nikhilkr96/details/recommendations/?detailScreenTabIndex=0); LinkedIn may require sign-in.

- The selection covers engineering leadership, product collaboration, staff and senior engineering perspectives, software and game development, and career mentorship. No geography is inferred from a name, company, or school.
- Recommendation wording is preserved in full, including original grammar and punctuation. LinkedIn UI labels are excluded. Entries ending in an apparent "more" truncation marker were not selected.
- Role labels are selected details from the supplied profile headlines, not independently verified current roles or roles at the time of recommendation. Only explicitly supplied relationships are shown.
- The recommendations are separate from Topmate reviews and do not change Topmate counts or claim that mentorship caused a particular job placement.
- All seven quotes are visible without JavaScript or expansion controls. The layout stacks attribution above the quote on mobile and does not clip long text.
- Keep source exports outside the published folder. Add or revise education, licenses, or certifications only when their source details are supplied or verified.

## Publishing

The configured deployment target is [cracker-jack/nikhil-kumar-portfolio](https://github.com/cracker-jack/nikhil-kumar-portfolio), using GitHub Pages from the `main` branch and repository root. No build step is needed.

The public base URL is:

`https://cracker-jack.github.io/nikhil-kumar-portfolio/`

All six pages have matching absolute canonical and `og:url` values. Their `og:image` points to the public `assets/social-card.png`; Person structured data points to the public home URL. `sitemap.xml` lists the same six canonical URLs.

If the domain or repository name changes, update those metadata values and the sitemap together. Navigation, stylesheets, scripts, favicon, and downloads use relative paths and also work at a domain root.

GitHub authentication, repository changes, and publishing are managed separately. These configured URLs do not by themselves mean the site has been deployed.

Only website files belong in the published folder. Keep browser captures, raw source documents, credentials, generators, and local validation artifacts outside it.
