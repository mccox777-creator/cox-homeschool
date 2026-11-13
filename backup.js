// Backup restore for the Godot web build. Loaded by the export's head_include.
//
// Saving a backup needs nothing here: Godot's JavaScriptBridge.download_buffer
// puts the file in the Chromebook's Downloads folder. Restoring needs a file
// picker, which Godot's web build does not have, so pick(onDone) opens the
// browser's own and calls onDone once with the file's text ("" if cancelled).
// The file is read on the device and goes nowhere else.
(function () {
  "use strict";
  window.HomeschoolBackup = {
    pick: function (onDone) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      var done = false;
      function finish(text) {
        if (done) return;
        done = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        onDone(text);
      }
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) return finish("");
        var reader = new FileReader();
        reader.onload = function () { finish(String(reader.result || "")); };
        reader.onerror = function () { finish(""); };
        reader.readAsText(file);
      });
      input.addEventListener("cancel", function () { finish(""); });
      // Attached and clicked on the next tick: called straight from Godot's
      // input handling, Chrome quietly ignored the click and no picker opened.
      input.style.display = "none";
      document.body.appendChild(input);
      setTimeout(function () { input.click(); }, 0);
    }
  };
})();
