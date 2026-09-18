/* Archway Paper Analyzer — asks a model for one strict JSON object describing a
 * passage of academic writing, then renders it. Owns the prompt, the defensive
 * parse, and the DOM. Everything about keys, models and HTTP lives in archway.js. */
(function () {
  "use strict";

  var SAMPLE = [
    "Retrieval-Practice Prompts in a Large Introductory Statistics Course: A Semester-Long Field Study",
    "",
    "Students in introductory statistics frequently report high confidence in material they cannot " +
      "later apply. We examined whether brief, low-stakes retrieval-practice prompts delivered " +
      "through a course management system improve end-of-term performance. Over one semester, 412 " +
      "undergraduates enrolled in a single introductory statistics course at a large private " +
      "university received a two-question prompt every Tuesday and Thursday covering material from " +
      "the preceding week. Prompts were ungraded and took a median of 94 seconds to complete. " +
      "Engagement was high: 78% of students answered at least three quarters of the prompts. Final " +
      "examination scores among students in the highest engagement quartile averaged 8.3 percentage " +
      "points above those in the lowest quartile, and the difference persisted after adjusting for " +
      "prior grade point average. Students also reported greater subjective preparedness on an " +
      "end-of-term survey (mean 4.1 of 5, up from 3.4 in the previous year's offering). We conclude " +
      "that lightweight retrieval prompts are an inexpensive lever for improving learning outcomes " +
      "in large lecture courses, and recommend that departments consider adopting them broadly " +
      "across the introductory curriculum.",
  ].join("\n");

  var SYSTEM =
    "You are a careful, skeptical research-methods reviewer. You read one passage of academic " +
    "writing and return a single JSON object describing it. You never invent detail the passage " +
    "does not contain: if something is absent, that absence is itself the finding.";

  var SCHEMA =
    '{"claim": string, "method": string, "sample": string, "findings": string[], ' +
    '"limitations": string[], "unsaid": string[], "jargon": [{"term": string, "plain": string}]}';

  var INSTRUCTIONS = [
    "Analyze the passage below and return ONE JSON object matching this schema exactly:",
    "",
    SCHEMA,
    "",
    "Field rules:",
    '- "claim": the central claim in one plain sentence, as the authors would state it.',
    '- "method": what was actually done, in two or three sentences. Name the design ' +
      "(randomized, observational, correlational, simulation) if it is determinable.",
    '- "sample": who or what was studied, with n and setting if stated. Write "Not stated" if absent.',
    '- "findings": 2 to 6 results the passage reports, each one sentence, with the numbers it gives.',
    '- "limitations": 2 to 6 weaknesses, whether acknowledged by the authors or following directly ' +
      "from the design as described.",
    '- "unsaid": 3 to 6 things a careful reader would expect this passage to state and it ' +
      "conspicuously does not — a missing control or baseline, absent confidence intervals or " +
      "effect sizes, unreported attrition, no external validation or replication, single site, " +
      "self-reported outcomes, unstated funding or conflicts, no preregistration. Each item must " +
      "be specific to this passage, not generic advice.",
    '- "jargon": up to 5 technical terms from the passage, each glossed in under 25 plain words. ' +
      "Use an empty array if the passage has no jargon.",
    "",
    "Return the JSON object and nothing else: no markdown fence, no preamble, no trailing notes.",
    "",
    "PASSAGE:",
  ].join("\n");

  var doc = document;
  var sourceBox = doc.getElementById("source");
  var countLine = doc.getElementById("source-count");
  var modelSelect = doc.getElementById("model");
  var analyzeBtn = doc.getElementById("analyze");
  var analyzeSpinner = doc.getElementById("analyze-spinner");
  var analyzeLabel = doc.getElementById("analyze-label");
  var cancelBtn = doc.getElementById("cancel");
  var loadBtn = doc.getElementById("load-example");
  var statusLine = doc.getElementById("status");
  var errorBox = doc.getElementById("error");
  var readoutBox = doc.getElementById("readout");
  var results = doc.getElementById("results");

  var controller = null;
  var markdown = "";
  var copyTimer = 0;
  var keyReady = false;
  var modelsReady = false;
  var busy = false;

  var sampleBadge = Archway.el("span", "badge badge--warn hidden", "Sample text — fabricated study");
  sampleBadge.title = "This abstract was written for the demo. It describes no real research.";
  loadBtn.parentNode.insertBefore(sampleBadge, loadBtn);

  Archway.mountThemeToggle(doc.getElementById("theme-toggle"));

  // ------------------------------------------------------------------ input

  function updateCount() {
    var text = sourceBox.value;
    var words = text.split(/\s+/).filter(Boolean).length;
    // The estimate is chars/4, which is close enough to warn before the gateway
    // refuses the reservation for a passage larger than the model's window.
    var long = text.length > 60000;
    var line =
      Archway.formatInt(text.length) +
      " characters · " +
      Archway.formatInt(words) +
      " words · ~" +
      Archway.formatInt(Math.ceil(text.length / 4)) +
      " tokens";
    if (long) line += " · long enough to risk the context window";
    countLine.textContent = line;
    // The count stays grey until it is news, at which point it is the only
    // coloured thing on the composer.
    countLine.classList.toggle("is-long", long);
    if (text !== SAMPLE) sampleBadge.classList.add("hidden");
  }

  sourceBox.addEventListener("input", updateCount);

  sourceBox.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !analyzeBtn.disabled) {
      event.preventDefault();
      analyze();
    }
  });

  loadBtn.addEventListener("click", function () {
    sourceBox.value = SAMPLE;
    updateCount();
    sampleBadge.classList.remove("hidden");
    sourceBox.focus();
    statusLine.textContent = "Sample loaded.";
  });

  // ------------------------------------------------------------------- keys

  /* An emptied error box is still a flex child of the results stack, so it has
   * to be hidden as well as cleared or it leaves a gap where nothing is. */
  function clearError() {
    Archway.clear(errorBox);
    errorBox.classList.add("hidden");
  }

  /* One place decides what is clickable: a key is present, models have loaded,
   * and no call is in flight. Every state change ends here - including the
   * in-flight affordances, so the spinner can never outlive the request. */
  function refreshControls() {
    sourceBox.disabled = !keyReady;
    loadBtn.disabled = !keyReady || busy;
    modelSelect.disabled = !modelsReady || busy;
    analyzeBtn.disabled = !modelsReady || busy;
    cancelBtn.classList.toggle("hidden", !busy);
    analyzeSpinner.classList.toggle("hidden", !busy);
    analyzeBtn.classList.toggle("is-busy", busy);
    analyzeLabel.textContent = busy ? "Analyzing" : "Analyze passage";
    results.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function setReady(ready) {
    keyReady = ready;
    if (!ready) {
      modelsReady = false;
      Archway.clear(modelSelect);
      modelSelect.appendChild(Archway.el("option", null, "Connect a key to load models"));
      showEmpty(
        "No analysis yet",
        "Connect your key, paste a passage above, then press Analyze passage."
      );
      clearError();
      Archway.renderReadout(readoutBox, null);
      statusLine.textContent = "";
      markdown = "";
    }
    refreshControls();
  }

  function loadModels() {
    statusLine.textContent = "Loading models…";
    return Archway.listModels()
      .then(function (models) {
        if (!models.length) {
          statusLine.textContent = "This key can call no chat models.";
          return;
        }
        // A long passage plus a strict-JSON answer rewards a large-context model,
        // so prefer a Claude alias when the catalogue offers one.
        Archway.fillModelSelect(modelSelect, models, "claude");
        modelsReady = true;
        statusLine.textContent = "";
        refreshControls();
      })
      .catch(function (err) {
        statusLine.textContent = "";
        Archway.renderError(errorBox, err);
      });
  }

  Archway.mountKeyPanel(doc.getElementById("key-mount"), {
    onReady: function () {
      clearError();
      setReady(true);
      loadModels();
    },
    onClear: function () {
      setReady(false);
    },
  });

  setReady(false);
  updateCount();

  // ----------------------------------------------------------------- parsing

  /* The model is asked for bare JSON and usually complies, but "usually" is not a
   * contract: fences and polite preambles both show up. Try the whole string, then
   * the contents of a fence, then the outermost brace span. */
  function parseAnalysis(text) {
    var trimmed = String(text || "").trim();
    var candidates = [trimmed];

    var fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1].trim());

    var last = candidates[candidates.length - 1];
    var start = last.indexOf("{");
    var end = last.lastIndexOf("}");
    if (start !== -1 && end > start) candidates.push(last.slice(start, end + 1));

    for (var i = 0; i < candidates.length; i += 1) {
      try {
        var value = JSON.parse(candidates[i]);
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch (e) {
        /* try the next candidate */
      }
    }
    return null;
  }

  function str(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function list(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    value.forEach(function (item) {
      var text = str(item);
      if (text) out.push(text);
    });
    return out;
  }

  function glossary(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    value.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      var term = str(item.term);
      var plain = str(item.plain);
      if (term && plain) out.push({ term: term, plain: plain });
    });
    return out.slice(0, 5);
  }

  /* A JSON object of the wrong shape parses cleanly and normalizes to nothing.
   * Treat that like a parse failure so the reader sees the reply, not blank cards. */
  function hasContent(analysis) {
    return Boolean(
      analysis.claim ||
        analysis.method ||
        analysis.sample ||
        analysis.findings.length ||
        analysis.limitations.length ||
        analysis.unsaid.length ||
        analysis.jargon.length
    );
  }

  function normalize(raw) {
    return {
      claim: str(raw.claim),
      method: str(raw.method),
      sample: str(raw.sample),
      findings: list(raw.findings),
      limitations: list(raw.limitations),
      unsaid: list(raw.unsaid),
      jargon: glossary(raw.jargon),
    };
  }

  // --------------------------------------------------------------- rendering

  /* Every empty state names the state and the next move. A bare "nothing here"
   * tells a first-time visitor nothing they could not already see. */
  function showEmpty(title, hint) {
    Archway.clear(results);
    var card = Archway.el("div", "card");
    var box = Archway.el("div", "empty");
    box.appendChild(Archway.el("p", "empty__title", title));
    if (hint) box.appendChild(Archway.el("p", "empty__hint", hint));
    card.appendChild(box);
    results.appendChild(card);
  }

  /* The call is non-streaming, so there is nothing to show for several seconds.
   * Skeleton bars in the shape of the report are the honest stand-in. */
  function showPending() {
    Archway.clear(results);
    var card = Archway.el("div", "card");

    var line = Archway.el("div", "row row--tight");
    line.appendChild(Archway.el("span", "spinner"));
    line.appendChild(
      Archway.el("span", "small muted", "Reading the passage and building the report…")
    );
    card.appendChild(line);

    var bars = Archway.el("div", "skeleton");
    bars.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 5; i += 1) bars.appendChild(Archway.el("span", "skeleton__bar"));
    card.appendChild(bars);

    results.appendChild(card);
  }

  /* A card head with the section's number beside its title. The number is what
   * turns seven cards into one document. */
  function head(num, title, extras) {
    var bar = Archway.el("div", "card__head");
    var group = Archway.el("div", "sec__title");
    if (num) group.appendChild(Archway.el("span", "sec__num", num));
    group.appendChild(Archway.el("h3", null, title));
    bar.appendChild(group);
    (extras || []).forEach(function (node) {
      bar.appendChild(node);
    });
    return bar;
  }

  function proseCard(num, title, body, className) {
    var card = Archway.el("section", "card" + (className ? " " + className : ""));
    card.appendChild(head(num, title));
    if (body) {
      card.appendChild(Archway.el("p", "prose", body));
    } else {
      card.appendChild(Archway.el("p", "prose muted", "The passage does not state this."));
    }
    return card;
  }

  /* opts: { className, badge, note, numbered } */
  function listCard(num, title, items, opts) {
    opts = opts || {};
    var card = Archway.el("section", "card" + (opts.className ? " " + opts.className : ""));
    card.appendChild(head(num, title, opts.badge ? [opts.badge] : []));
    if (opts.note) card.appendChild(Archway.el("p", "card__note", opts.note));

    if (!items.length) {
      card.appendChild(Archway.el("p", "prose muted", "Nothing returned for this section."));
      return card;
    }

    // An <ol> for findings so the numbers are real to a screen reader too; the
    // chip itself is drawn by CSS counters.
    var list = Archway.el(
      opts.numbered ? "ol" : "ul",
      "analysis-list" + (opts.numbered ? " analysis-list--num" : "")
    );
    items.forEach(function (item) {
      list.appendChild(Archway.el("li", null, item));
    });
    card.appendChild(list);
    return card;
  }

  function jargonCard(num, entries) {
    var card = Archway.el("section", "card");
    card.appendChild(head(num, "Jargon, in plain words"));
    if (!entries.length) {
      card.appendChild(Archway.el("p", "prose muted", "No technical terms flagged."));
      return card;
    }
    var dl = Archway.el("dl", "gloss");
    entries.forEach(function (entry) {
      // <div> inside <dl> is valid and is what keeps a term and its gloss one
      // grid cell rather than two independently flowing ones.
      var row = Archway.el("div");
      row.appendChild(Archway.el("dt", null, entry.term));
      row.appendChild(Archway.el("dd", null, entry.plain));
      dl.appendChild(row);
    });
    card.appendChild(dl);
    return card;
  }

  /* The report's title row. Deliberately not a card: it reads as the document
   * header the sections below it belong to. */
  function reportHead(modelId, note) {
    var wrap = Archway.el("header", "report__head");

    var row = Archway.el("div", "row");
    row.appendChild(Archway.el("h2", null, "Analysis"));

    var model = Archway.el("span", "badge badge--accent spacer", modelId);
    model.title = "The model alias this analysis was generated with.";
    row.appendChild(model);

    var copy = Archway.el("button", "btn btn--sm", "Copy as Markdown");
    copy.type = "button";
    copy.addEventListener("click", function () {
      copyMarkdown(copy);
    });
    row.appendChild(copy);

    wrap.appendChild(row);
    wrap.appendChild(
      Archway.el(
        "p",
        "report__note",
        note ||
          "Generated from the passage above. Check anything you plan to cite against the full paper."
      )
    );
    return wrap;
  }

  function omissionBadge(count) {
    return Archway.el(
      "span",
      "badge badge--warn",
      count === 1 ? "1 omission" : count + " omissions"
    );
  }

  function render(analysis, modelId) {
    Archway.clear(results);
    results.appendChild(reportHead(modelId, null));
    results.appendChild(proseCard("01", "Central claim", analysis.claim, "card--claim"));

    var pair = Archway.el("div", "grid");
    pair.appendChild(proseCard("02", "Method", analysis.method));
    pair.appendChild(proseCard("03", "Sample", analysis.sample));
    results.appendChild(pair);

    var lists = Archway.el("div", "grid");
    lists.appendChild(
      listCard("04", "Findings as reported", analysis.findings, { numbered: true })
    );
    lists.appendChild(listCard("05", "Limitations", analysis.limitations, {}));
    results.appendChild(lists);

    results.appendChild(
      listCard("06", "What the abstract does not say", analysis.unsaid, {
        className: "card--unsaid",
        badge: analysis.unsaid.length ? omissionBadge(analysis.unsaid.length) : null,
        note:
          "Expected of a passage like this one, and absent from it. An omission is not proof of " +
          "a flaw — it is a question to take to the full text.",
      })
    );

    results.appendChild(jargonCard("07", analysis.jargon));
    results.focus();
  }

  function renderRaw(text, modelId) {
    Archway.clear(results);
    results.appendChild(
      reportHead(modelId, "The model did not return usable JSON, so here is exactly what it said.")
    );

    var card = Archway.el("section", "card");
    card.appendChild(
      head(null, "Unparsed response", [Archway.el("span", "badge badge--warn", "raw")])
    );
    card.appendChild(
      Archway.el(
        "p",
        "card__note",
        "Nothing was lost — the text below is the complete reply. Running it again usually " +
          "produces valid JSON."
      )
    );
    var pre = Archway.el("pre", "raw");
    pre.textContent = text || "(the model returned an empty response)";
    card.appendChild(pre);
    results.appendChild(card);
    results.focus();
  }

  // ---------------------------------------------------------------- markdown

  function bullets(items) {
    if (!items.length) return "_none returned_\n";
    return items
      .map(function (item) {
        return "- " + item;
      })
      .join("\n") + "\n";
  }

  function toMarkdown(analysis, modelId) {
    var out = "# Paper analysis\n\n";
    out += "Model: `" + modelId + "` · via the NYU Archway\n\n";
    out += "## Central claim\n\n" + (analysis.claim || "_not stated_") + "\n\n";
    out += "## Method\n\n" + (analysis.method || "_not stated_") + "\n\n";
    out += "## Sample\n\n" + (analysis.sample || "_not stated_") + "\n\n";
    out += "## Findings as reported\n\n" + bullets(analysis.findings) + "\n";
    out += "## Limitations\n\n" + bullets(analysis.limitations) + "\n";
    out += "## What the abstract does not say\n\n" + bullets(analysis.unsaid) + "\n";
    out += "## Jargon\n\n";
    out += analysis.jargon.length
      ? analysis.jargon
          .map(function (entry) {
            return "- **" + entry.term + "** — " + entry.plain;
          })
          .join("\n") + "\n"
      : "_none flagged_\n";
    out += "\n---\n\nA reading aid, not a substitute for reading the paper.\n";
    return out;
  }

  // Four backticks: the unparsed reply very often contains a three-backtick fence.
  function rawMarkdown(text, modelId) {
    return (
      "# Paper analysis (unparsed)\n\nModel: `" +
      modelId +
      "` · via the NYU Archway\n\nThe reply was not valid JSON. Verbatim:\n\n````\n" +
      text +
      "\n````\n"
    );
  }

  function writeToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  // Safari without permission, and any page served over plain http, land here.
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var scratch = doc.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.top = "-1000px";
      doc.body.appendChild(scratch);
      scratch.select();
      var ok = false;
      try {
        ok = doc.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      doc.body.removeChild(scratch);
      if (ok) resolve();
      else reject(new Error("The browser blocked the copy. Select the text and copy it manually."));
    });
  }

  function copyMarkdown(button) {
    if (!markdown) return;
    writeToClipboard(markdown)
      .then(function () {
        button.textContent = "Copied";
      })
      .catch(function (err) {
        button.textContent = "Copy failed";
        Archway.renderError(errorBox, err);
      })
      .finally(function () {
        if (copyTimer) window.clearTimeout(copyTimer);
        copyTimer = window.setTimeout(function () {
          button.textContent = "Copy as Markdown";
        }, 1800);
      });
  }

  // ----------------------------------------------------------------- analyze

  function setBusy(value) {
    busy = value;
    refreshControls();
  }

  cancelBtn.addEventListener("click", function () {
    if (controller) controller.abort();
    statusLine.textContent = "Cancelled.";
  });

  function analyze() {
    var text = sourceBox.value.trim();
    if (text.length < 80) {
      statusLine.textContent = "Paste an abstract first — at least a couple of sentences.";
      sourceBox.focus();
      return;
    }

    var modelId = modelSelect.value;
    clearError();
    Archway.renderReadout(readoutBox, null);
    showPending();
    // The button and the pending card both already say it is working; a third
    // "Analyzing…" beside them is noise, not reassurance.
    statusLine.textContent = "";

    controller = new AbortController();
    setBusy(true);

    var started = Date.now();
    Archway.chat({
      model: modelId,
      system: SYSTEM,
      messages: [{ role: "user", content: INSTRUCTIONS + "\n\n" + text }],
      maxTokens: 1600,
      // Low but not zero: the analysis should be stable across runs of the same text.
      temperature: 0.2,
      signal: controller.signal,
    })
      .then(function (result) {
        Archway.renderReadout(readoutBox, result.headers, { ms: Date.now() - started });
        var raw = parseAnalysis(result.text);
        var analysis = raw ? normalize(raw) : null;
        if (analysis && hasContent(analysis)) {
          markdown = toMarkdown(analysis, modelId);
          render(analysis, modelId);
          statusLine.textContent =
            result.finishReason === "length" ? "Stopped at the output limit — may be truncated." : "";
        } else {
          markdown = rawMarkdown(result.text, modelId);
          renderRaw(result.text, modelId);
          statusLine.textContent = "The reply was not usable JSON — showing it verbatim.";
        }
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") {
          showEmpty("Cancelled", "Nothing was analyzed. Press Analyze passage to try again.");
          return;
        }
        statusLine.textContent = "";
        showEmpty("The analysis did not complete", "The message above says why.");
        Archway.renderError(errorBox, err);
      })
      .finally(function () {
        controller = null;
        setBusy(false);
      });
  }

  analyzeBtn.addEventListener("click", analyze);
})();
