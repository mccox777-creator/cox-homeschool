// Speech bridge for the Godot web build. Loaded by the export's head_include,
// next to vosk.js (vosk-browser 0.0.8, Apache-2.0).
//
// Godot calls window.HomeschoolSpeech through JavaScriptBridge. Everything here
// runs in the browser on the device: the model is a file served beside the
// game, and no audio leaves the machine.
//
// listen(target, alternatives, onDone) opens the microphone, listens for the
// given words (a grammar, not open dictation) until the child has finished
// talking, and calls onDone once with a JSON string: {"ok":true,"text":"ship","words":[{"word":"ship","conf":0.93}]}
// or {"ok":false,"error":"..."}. Scoring is Godot's job (speech_score.gd), so
// this file only reports what was heard.
(function () {
  "use strict";

  var model = null;
  var loading = null;
  var status = "idle"; // idle | loading | ready | error
  var lastError = "";

  // How long the first download of the model (about 40 MB) may take before
  // the app stops waiting and sends the children to Dad instead.
  var LOAD_MS = 180000;

  function load(modelUrl) {
    if (loading) return loading;
    status = "loading";
    // The model is fetched inside vosk's worker, which reads a relative path
    // from the top of the website, not from the app's folder: on GitHub Pages
    // (https://mccox777-creator.github.io/cox-homeschool/) "model.tar.gz" became
    // https://mccox777-creator.github.io/model.tar.gz, which is not there, and
    // the listener said "getting ready" forever. So give it the full address.
    var url = new URL(modelUrl, document.baseURI).href;
    // vosk-browser never settles its promise when the file is missing (the
    // failure happens inside its worker), so check the file is there first
    // and report it, and never wait longer than LOAD_MS.
    var timer = null;
    var late = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error("the speech model took too long to load")); }, LOAD_MS);
    });
    loading = Promise.race([late, fetch(url, { method: "HEAD" })
      .then(function (r) {
        if (!r.ok) throw new Error(url + " not found (HTTP " + r.status + "): run tools/get_model.sh");
        return Vosk.createModel(url);
      })])
      .then(function (m) { clearTimeout(timer); model = m; status = "ready"; return m; })
      .catch(function (e) { clearTimeout(timer); status = "error"; lastError = String(e); loading = null; throw e; });
    return loading;
  }

  function stopAll(ctx, stream, node, source) {
    try { if (source) source.disconnect(); } catch (e) {}
    try { if (node) node.disconnect(); } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (ctx) ctx.close(); } catch (e) {}
  }

  // How loud the microphone is right now, 0 to 1, for the meter on screen
  // ("I can hear you"). Only a number: no sound is kept or sent anywhere.
  var micLevel = 0;
  var voiceNow = false;

  // Waiting for the child to finish. The recognizer reports a result at
  // every short pause, and a child sounding a word out ("nav... i... ga...
  // tor") pauses a lot, so a first result is not the end of her turn. The
  // turn ends after QUIET_MS of quiet once she has started, or MAX_LISTEN_MS
  // if she never starts, and never runs past LONGEST_MS.
  var MAX_LISTEN_MS = 7000;
  var QUIET_MS = 1400;
  var LONGEST_MS = 15000;

  // The turn under way, so Godot can end it early (stop, or "I'm done") and a
  // new turn never leaves an old microphone open.
  var current = null;

  function listen(target, alternatives, onDone) {
    if (current) current.stop();
    var done = false;
    var ctx = null, stream = null, node = null, source = null, recognizer = null;
    var timer = null, ending = false;
    var heard = [];       // words from every result in this turn
    var texts = [];
    var started = Date.now();
    var spokeAt = 0;      // when her voice was last above the quiet level
    var voiceMs = 0;      // how long she has spoken in all
    var floor = 0.01;     // the room's quiet level, learned as we go

    function finish(payload) {
      if (done) return;
      done = true;
      micLevel = 0;
      voiceNow = false;
      if (timer) clearInterval(timer);
      clearTimeout(guard);
      if (current === turn) current = null;
      stopAll(ctx, stream, node, source);
      try { if (recognizer) recognizer.remove(); } catch (e) {}
      onDone(JSON.stringify(payload));
    }

    function heardSoFar() {
      return { ok: true, text: texts.join(" "), words: heard };
    }

    // Her turn is over: ask for the last bit the recognizer is holding, then
    // report everything heard in the turn.
    function endTurn() {
      if (ending) return;
      ending = true;
      try { recognizer.retrieveFinalResult(); } catch (e) {}
      setTimeout(function () { finish(heardSoFar()); }, 700);
    }

    // endTurn before the microphone is open has nothing to wait for.
    function endNow() {
      if (recognizer) endTurn(); else finish(heardSoFar());
    }
    var turn = {
      stop: function () { finish({ ok: false, error: "stopped" }); },
      end: endNow
    };
    current = turn;
    // A turn always ends, even when the microphone never opens (a permission
    // question nobody answered): otherwise the app waits forever, with every
    // button that listens or talks doing nothing.
    var guard = setTimeout(endNow, LONGEST_MS + 1000);

    if (!model) { finish({ ok: false, error: "model not loaded (" + status + ")" }); return; }

    // Godot passes the alternatives as a JSON string; arrays do not cross the bridge.
    if (typeof alternatives === "string") {
      try { alternatives = JSON.parse(alternatives); } catch (e) { alternatives = []; }
    }
    var words = [String(target).toLowerCase()];
    (alternatives || []).forEach(function (w) { words.push(String(w).toLowerCase()); });
    words.push("[unk]");

    navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    }).then(function (s) {
      if (done) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
      stream = s;
      ctx = new AudioContext();
      recognizer = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify(words));
      recognizer.setWords(true);
      recognizer.on("result", function (message) {
        var r = message.result || {};
        // An empty result is silence; keep listening until her turn is over.
        if (!r.text) return;
        texts.push(r.text);
        (r.result || []).forEach(function (w) { heard.push(w); });
      });
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (event) {
        if (done) return;
        var data = event.inputBuffer.getChannelData(0);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
        var rms = Math.sqrt(sum / data.length);
        // The quiet level drifts down fast and up slowly, so talking does
        // not raise it but a humming fan does.
        floor = rms < floor ? floor * 0.7 + rms * 0.3 : floor * 0.995 + rms * 0.005;
        voiceNow = rms > Math.max(0.012, floor * 3);
        var ms = 1000 * data.length / ctx.sampleRate;
        if (voiceNow) { spokeAt = Date.now(); voiceMs += ms; }
        var shown = Math.min(1, Math.sqrt(rms) * 2.2);
        micLevel = shown > micLevel ? shown : micLevel * 0.8 + shown * 0.2;
        if (!ending) {
          try { recognizer.acceptWaveform(event.inputBuffer); } catch (e) {}
        }
      };
      source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      node.connect(ctx.destination);
      timer = setInterval(function () {
        var now = Date.now();
        var talked = voiceMs >= 150;
        if (talked && now - spokeAt >= QUIET_MS) endTurn();             // she finished
        else if (!talked && now - started >= MAX_LISTEN_MS) endTurn();  // she never started
        else if (now - started >= LONGEST_MS) endTurn();
      }, 100);
    }).catch(function (e) {
      finish({ ok: false, error: "microphone: " + (e && e.name ? e.name : String(e)) });
    });
  }

  window.HomeschoolSpeech = {
    load: function (modelUrl) { load(modelUrl).catch(function () {}); },
    status: function () { return status; },
    lastError: function () { return lastError; },
    level: function () { return micLevel; },
    hearing: function () { return voiceNow; },
    listen: listen,
    // End the turn now and report nothing (the app moved on).
    stop: function () { if (current) current.stop(); },
    // She says she is done: report what was heard so far.
    end: function () { if (current) current.end(); }
  };
})();
