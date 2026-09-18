# Archway Paper Analyzer

Paste an abstract or a section of a paper and get a structured critical breakdown:
claim, method, sample, findings, limitations, jargon â€” and the things the passage
conspicuously does not say.

It is an example app for the **NYU Archway**, the university's API gateway in front of
third-party AI vendors. The Archway concept it demonstrates is **strict structured
output over a long context**: one non-streaming completion that has to come back as a
single JSON object, parsed defensively because "has to" is not a guarantee.

## Try it

<https://andrewbuildsnyu.github.io/archway-analyzer/>

Everything runs in your browser. The page talks to the Archway and to nothing else.

## Get a key

Issue yourself a key from the Archway portal, at `/portal` on the gateway.

**Make a low-quota key.** Any browser app holds its key in the page, where the person
using the page can read it. This one keeps the key in `sessionStorage` and sends it only
to the Archway, but that is a limit on accidents, not on a determined reader. Do not
paste a key here that also covers something you care about.

## Run it locally

```
git clone https://github.com/AndrewBuildsNYU/archway-analyzer.git
cd archway-analyzer
```

Then open `index.html` in a browser. There is no build step, no package manager, and
nothing to install â€” it is three files and two shared ones.

Pointing the app at a *different* Archway (the `BASE_URL` constant in `assets/archway.js`,
deliberately not a field in the UI) needs
that gateway to list this page's origin in `NYU_CORS_ALLOWED_ORIGINS`. Opening the file
straight from disk sends an origin of `null`, which most gateways reject; if you see
"This origin is not allowed", serve the folder with any static file server and add that
origin to the gateway's allow-list.

## How it works

The interesting part is the round trip between a prompt that demands JSON and a parser
that assumes it will not get it.

The prompt names the schema field by field and ends with "return the JSON object and
nothing else". Models mostly comply. Mostly is not a contract, so `parseAnalysis()` in
`assets/app.js` tries three candidates in order: the whole reply, the contents of a
` ```json ` fence if one is there, and the outermost `{ â€¦ }` span if the model wrapped
its answer in prose. If all three fail, the app shows the complete raw reply in a `<pre>`
with a notice instead of throwing away the response or crashing the page.

The call is non-streaming on purpose. There is nothing to show until the whole object has
arrived, so `Archway.chat()` is the right tool and `Archway.streamChat()` is not.

The `unsaid` field is the part worth stealing. It asks what a careful reader would expect
the passage to state and it does not â€” a missing control group, absent confidence
intervals, unreported attrition, no funding statement. Absence is hard to notice by
reading and easy to ask for explicitly, which is most of why the section exists.

Model output is untrusted text, so every value from the response is written with
`textContent` through `Archway.el()`. There is no `innerHTML` in this app.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page structure and the handful of layout rules this app adds |
| `assets/app.js` | The prompt, the defensive JSON parse, the rendering, the Markdown export |
| `assets/archway.js` | Shared Archway client: key panel, model list, `chat()`, readout, errors |
| `assets/archway.css` | Shared design system: tokens, components, dark mode |

The two `archway.*` files are copied in from the examples collection and are identical
across every Archway example.

## A caveat worth repeating

This is a reading aid, not a substitute for reading the paper. A language model can
misread a method, miss a caveat the text does state, or invent one it does not. Check
anything you would cite against the full text.

MIT licensed.
