/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let LANGUAGES = {};
let LANGUAGE;
let sttApi = "Google"; //or Mozilla
const sttApiKey = "AIzaSyCS8ClSVkV44I_eociznVQMM2WLLAfGNU8";

const languagePromise = fetch(browser.extension.getURL("languages.json"))
  .then(response => {
    return response.json();
  })
  .then(l => {
    LANGUAGES = l;
    return browser.storage.sync.get("language");
  })
  .then(item => {
    if (!item.language) {
      throw new Error("Language not set");
    }

    LANGUAGE = item.language;
  })
  .catch(() => {
    LANGUAGE = LANGUAGES.hasOwnProperty(navigator.language)
      ? navigator.language
      : "en-US";
  });

(function speak_to_me() {
  console.log("Speak To Me starting up...");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error(
      "You need a browser with getUserMedia support to use Speak To Me, sorry!"
    );
    return;
  }

  let mediaRecorder = null;
  const metrics = new Metrics();
  const GOOGLE_STT_SERVER_URL =
    "https://speech.googleapis.com/v1/speech:recognize";
  const MOZILLA_STT_SERVER_URL = "https://speaktome-2.services.mozilla.com";
  let STT_SERVER_URL;
  if (sttApi === "Google") {
    STT_SERVER_URL = GOOGLE_STT_SERVER_URL + "?key=" + sttApiKey;
  } else {
    STT_SERVER_URL = MOZILLA_STT_SERVER_URL;
  }

  const escapeHTML = str => {
    // Note: string cast using String; may throw if `str` is non-serializable, e.g. a Symbol.
    // Most often this is not the case though.
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  };

  browser.runtime.onMessage.addListener(request => {
    // this.icon.classList.add("stm-hidden");
    // document.getElementsByClassName("stm-icon")[0].disabled = true;
    metrics.start_session("toolbar");
    SpeakToMePopup.showAt(0, 0);
    stm_start();
    return Promise.resolve({ response: "content script ack" });
  });

  // Encapsulation of the popup we use to provide our UI.
  const POPUP_WRAPPER_MARKUP = `<div id="stm-popup" style="display:none">
            <div id="stm-header"><div role="button" tabindex="1" id="stm-close"></div></div>
            <div id="stm-inject"></div>
            <div id="stm-footer">
                Processing as {language}.
                <br>
                To change language, navigate to
                <a href="about:addons">about:addons</a>, then click the
                Preferences button next to VRStore-Voice.
            </div>
            <a href="https://qsurvey.mozilla.com/s3/voice-fill?ref=product&ver=2" id="stm-feedback" role="button" tabindex="2">Feedback</a>
        </div>`;

  // When submitting, this markup is passed in
  const SUBMISSION_MARKUP = `<div id="stm-levels-wrapper" style="display:none">
            <canvas hidden id="stm-levels" width=720 height=310></canvas>
        </div>
        <div id="stm-animation-wrapper">
            <div id="stm-box"></div>
        </div>
        <div id="stm-content">
            <div id="stm-startup-text">Warming up...</div>
        </div>`;

  // When Selecting, this markup is passed in
  const SELECTION_MARKUP = `<form id="stm-selection-wrapper" style="display:none">
            <div id="stm-list-wrapper">
                <input id="stm-input" type="text" autocomplete="off" />
                <div id="stm-list"></div>
            </div>
            <button id="stm-reset-button" title="Reset" type="button"></button>
            <input id="stm-submit-button" type="submit" title="Submit" value=""/>
        </form>`;

  const SpeakToMePopup = {
    // closeClicked used to skip out of media recording handling
    closeClicked: false,
    init: () => {
      console.log(`SpeakToMePopup init`);
      const popup = document.createElement("div");
      popup.innerHTML = POPUP_WRAPPER_MARKUP;
      document.body.appendChild(popup);

      languagePromise.then(() => {
        const footer = document.getElementById("stm-footer");
        footer.innerHTML = footer.innerHTML.replace(
          "{language}",
          LANGUAGES[LANGUAGE]
        );
      });
      this.inject = document.getElementById("stm-inject");
      this.inject.innerHTML = SUBMISSION_MARKUP;
    },

    showAt: () => {
      this.dismissPopup = function(e) {
        const key = e.which || e.keyCode;
        if (key === 27) {
          SpeakToMePopup.cancelFetch = true;
          e.preventDefault();
          metrics.end_session();
          SpeakToMePopup.hide();
          mediaRecorder.stop();
          SpeakToMePopup.closeClicked = true;
        }
      };
      this.addEventListener("keypress", this.dismissPopup);
    },

    hide: () => {
      console.log(`SpeakToMePopup hide`);
      this.removeEventListener("keypress", this.dismissPopup);

      setTimeout(() => {
        this.inject.innerHTML = SUBMISSION_MARKUP;
      }, 500);
    },

    reset: () => {
      this.inject.innerHTML = SUBMISSION_MARKUP;
    },

    // Returns a Promise that resolves once the "Stop" button is clicked.
    wait_for_stop: () => {
      console.log(`SpeakToMePopup wait_for_stop`);
      return new Promise((resolve, reject) => {
        console.log(`SpeakToMePopup set popup stop listener`);
      });
    },

    // Returns a Promise that resolves to the chosen text.
    choose_item: data => {
      console.log(`SpeakToMePopup choose_item`);
      this.inject.innerHTML = SELECTION_MARKUP;
      const close = document.getElementById("stm-close");
      const form = document.getElementById("stm-selection-wrapper");
      const input = document.getElementById("stm-input");
      const list = document.getElementById("stm-list");
      const listWrapper = document.getElementById("stm-list-wrapper");
      const reset = document.getElementById("stm-reset-button");
      let firstChoice;

      return new Promise((resolve, reject) => {
        if (data.length === 1) {
          firstChoice = data[0];
          listWrapper.removeChild(list);
        } else {
          let html = "<ul class='stm-list-inner'>";
          data.forEach((item, index) => {
            if (index === 0) {
              firstChoice = item;
            } else if (index < 5) {
              let confidence = escapeHTML(item.confidence);
              let text = escapeHTML(item.text);
              html += `<li idx_suggestion="${index}" confidence="${confidence}" role="button" tabindex="0">${text}</li>`;
            }
          });
          html += "</ul>";
          list.innerHTML = html;
        }

        input.confidence = escapeHTML(firstChoice.confidence);
        input.value = escapeHTML(firstChoice.text);
        input.size = Math.max(input.value.length, 10);
        input.idx_suggestion = 0;

        if (list) {
          list.style.width = `${input.offsetWidth}px`;
        }

        input.focus();

        input.addEventListener("keypress", e => {
          // e.preventDefault();
          if (e.keyCode === 13) {
            e.preventDefault();
            list.classList.add("close");
            resolve(input);
          }
        });

        input.addEventListener("input", () => {
          input.size = Math.max(10, input.value.length);
          list.style.width = `${input.offsetWidth}px`;
        });

        form.addEventListener("submit", function _submit_form(e) {
          e.preventDefault();
          e.stopPropagation();
          list.classList.add("close");
          form.removeEventListener("submit", _submit_form);
          resolve(input);
        });

        list.addEventListener("click", function _choose_item(e) {
          e.preventDefault();
          list.removeEventListener("click", _choose_item);
          if (e.target instanceof HTMLLIElement) {
            let result = [];
            result.confidence = e.target.getAttribute("confidence");
            result.value = e.target.textContent;
            result.idx_suggestion = e.target.getAttribute("idx_suggestion");
            list.classList.add("close");
            input.value = e.target.textContent;
            input.size = input.value.length;
            list.style.width = `${input.offsetWidth}px`;

            resolve(result);
          }
        });

        list.addEventListener("keypress", function _choose_item(e) {
          const key = e.which || e.keyCode;
          if (key === 13) {
            list.removeEventListener("click", _choose_item);
            if (e.target instanceof HTMLLIElement) {
              let result = [];
              result.confidence = e.target.getAttribute("confidence");
              result.value = e.target.textContent;
              result.idx_suggestion = e.target.getAttribute("idx_suggestion");
              list.classList.add("close");
              input.value = e.target.textContent;
              input.size = input.value.length;
              list.style.width = `${input.offsetWidth}px`;

              resolve(result);
            }
          }
        });

        reset.addEventListener("click", function _reset_click(e) {
          e.preventDefault();
          reset.removeEventListener("click", _reset_click);
          reject(e.target.id);
        });

        close.addEventListener("click", function _close_click(e) {
          e.preventDefault();
          close.removeEventListener("click", _close_click);
          reject(e.target.id);
        });

        close.addEventListener("keypress", function _close_click(e) {
          const key = e.which || e.keyCode;
          if (key === 13) {
            e.preventDefault();
            close.removeEventListener("keypress", _close_click);
            reject(e.target.id);
          }
        });
      });
    }
  };

  // Main startup for STM voice stuff
  const stm_start = () => {
    const constraints = { audio: true };
    let chunks = [];

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(function(stream) {
        // Build the WebAudio graph we'll be using
        let audioContext = new AudioContext();
        let sourceNode = audioContext.createMediaStreamSource(stream);
        let analyzerNode = audioContext.createAnalyser();
        let outputNode = audioContext.createMediaStreamDestination();
        // make sure we're doing mono everywhere
        sourceNode.channelCount = 1;
        analyzerNode.channelCount = 1;
        outputNode.channelCount = 1;
        // connect the nodes together
        sourceNode.connect(analyzerNode);
        analyzerNode.connect(outputNode);
        // and set up the recorder
        const options = {
          audioBitsPerSecond: 16000,
          mimeType: "audio/ogg"
        };

        // VAD initializations
        // console.log("Sample rate: ", audioContext.sampleRate);
        const bufferSize = 2048;
        // create a javascript node
        let scriptprocessor = audioContext.createScriptProcessor(
          bufferSize,
          1,
          1
        );
        // specify the processing function
        stm_vad.reset();
        scriptprocessor.onaudioprocess = stm_vad.recorderProcess;
        stm_vad.stopGum = () => {
          console.log("stopGum");
          mediaRecorder.stop();
          sourceNode.disconnect(scriptprocessor);
          sourceNode.disconnect(analyzerNode);
          analyzerNode.disconnect(outputNode);
        };
        // connect stream to our recorder
        sourceNode.connect(scriptprocessor);

        // MediaRecorder initialization
        mediaRecorder = new MediaRecorder(outputNode.stream, options);

        SpeakToMePopup.wait_for_stop().then(
          () => {
            mediaRecorder.stop();
          },
          () => {
            mediaRecorder.stop();
            SpeakToMePopup.closeClicked = true;
            metrics.end_session();
            SpeakToMePopup.hide();
          }
        );

        document.getElementById("stm-levels").hidden = false;
        visualize(analyzerNode);

        metrics.start_attempt();
        mediaRecorder.start();
        metrics.start_recording();

        const copy = document.getElementById("stm-content");
        copy.innerHTML = `<div id="stm-listening-text">Listening...</div>`;
        if (document.querySelector("#microPhone")) {
          document
            .querySelector("#microPhone")
            .setAttribute("src", "#micro-listening");
        }

        mediaRecorder.onstop = e => {
          metrics.stop_recording();
          // handle clicking on close element by dumping recording data
          if (SpeakToMePopup.closeClicked) {
            SpeakToMePopup.closeClicked = false;
            return;
          }

          console.log(e.target);
          document.getElementById("stm-levels").hidden = true;
          console.log("mediaRecorder onStop");
          // We stopped the recording, send the content to the STT server.
          mediaRecorder = null;
          audioContext = null;
          sourceNode = null;
          analyzerNode = null;
          outputNode = null;
          stream = null;
          scriptprocessor = null;

          const blob = new Blob(chunks, {
            type: "audio/ogg; codecs=opus"
          });
          chunks = [];
          var body, headers;

          function finalBase64(res) {
            body = JSON.stringify({
              audio: {
                content: res
              },
              config: {
                encoding: "OGG_OPUS",
                sampleRateHertz: 48000,
                languageCode: "en-US"
              }
            });
            headers = {
              "Content-Type": "application/json"
            };
            stt_fetch_api(body, headers);
          }

          function stt_fetch_api(body, headers) {
            fetch(STT_SERVER_URL, {
              method: "POST",
              body: body,
              headers: headers
            })
              .then(response => {
                if (!response.ok) {
                  fail_gracefully(`Fetch error: ${response.statusText}`);
                }
                metrics.end_stt();
                return response.json();
              })
              .then(json => {
                if (SpeakToMePopup.cancelFetch) {
                  SpeakToMePopup.cancelFetch = false;
                  return;
                }
                console.log(`Got STT result: ${JSON.stringify(json)}`);
                if (sttApi === "Google") {
                  display_options(json.results);
                } else {
                  display_options(json.data);
                }
              })
              .catch(error => {
                fail_gracefully(`Fetch error: ${error}`);
              });
          }
          if (sttApi === "Google") {
            blobToBase64(blob, finalBase64);
          } else {
            headers = {
              "Accept-Language-STT": LANGUAGE,
              "Product-Tag": "vf"
            };
            stt_fetch_api(blob, headers);
          }
          metrics.start_stt();
        };

        mediaRecorder.ondataavailable = e => {
          chunks.push(e.data);
        };
      })
      .catch(function(err) {
        fail_gracefully(`GUM error: ${err}`);
      });
  };

  // Click handler for stm icon
  const on_stm_icon_click = event => {
    if (SpeakToMePopup.cancelFetch) {
      SpeakToMePopup.cancelFetch = false;
    }
    const type = event.detail ? "button" : "keyboard";
    event.preventDefault();
    metrics.start_session(type);
    SpeakToMePopup.showAt();
    stm_start();
  };

  document.addEventListener(
    "speech-recognition-start",
    function(event) {
      console.log("Event received from VRStore");
      on_stm_icon_click(event);
    },
    false
  );
  // Helper to handle background visualization
  const visualize = analyzerNode => {
    const MIN_DB_LEVEL = -85; // The dB level that is 0 in the levels display
    const MAX_DB_LEVEL = -30; // The dB level that is 100% in the levels display

    // Set up the analyzer node, and allocate an array for its data
    // FFT size 64 gives us 32 bins. But those bins hold frequencies up to
    // 22kHz or more, and we only care about visualizing lower frequencies
    // which is where most human voice lies, so we use fewer bins
    analyzerNode.fftSize = 64;
    const frequencyBins = new Float32Array(14);

    // Clear the canvas

    var popupWidth = document.getElementById("stm-popup").offsetWidth;

    const levels = document.getElementById("stm-levels");
    const xPos =
      popupWidth < levels.offsetWidth
        ? popupWidth * 0.5 - 22
        : levels.offsetWidth * 0.5;
    const yPos = levels.offsetHeight * 0.5;
    const context = levels.getContext("2d");
    context.clearRect(0, 0, levels.width, levels.height);

    if (levels.hidden) {
      // If we've been hidden, return right away without calling rAF again.
      return;
    }

    // Get the FFT data
    analyzerNode.getFloatFrequencyData(frequencyBins);

    // Display it as a barchart.
    // Drop bottom few bins, since they are often misleadingly high
    const skip = 2;
    const n = frequencyBins.length - skip;
    const dbRange = MAX_DB_LEVEL - MIN_DB_LEVEL;

    // Loop through the values and draw the bars
    context.strokeStyle = "#d1d2d3";

    for (let i = 0; i < n; i++) {
      const value = frequencyBins[i + skip];
      const diameter =
        ((levels.height * (value - MIN_DB_LEVEL)) / dbRange) * 10;
      if (diameter < 0) {
        continue;
      }
      // Display a bar for this value.
      var alpha = diameter / 500;
      if (alpha > 0.2) alpha = 0.2;
      else if (alpha < 0.1) alpha = 0.1;

      context.lineWidth = alpha * alpha * 150;
      context.globalAlpha = alpha * alpha * 5;
      context.beginPath();
      context.ellipse(xPos, yPos, diameter, diameter, 0, 0, 2 * Math.PI);
      if (diameter > 90 && diameter < 360) context.stroke();
    }
    // Update the visualization the next time we can
    requestAnimationFrame(function() {
      visualize(analyzerNode);
    });
  };

  const display_options = items => {
    // Filter the array for empty items and normalize the text.
    let data;
    if (sttApi === "Google") {
      data = items
        .filter(item => {
          return item.alternatives[0].transcript !== "";
        })
        .map(item => {
          return {
            confidence: item.alternatives[0].confidence,
            text: item.alternatives[0].transcript.toLowerCase()
          };
        });
    } else {
      data = items
        .filter(item => {
          return item.text !== "";
        })
        .map(item => {
          return {
            confidence: item.confidence,
            text: item.text.toLowerCase()
          };
        });
    }
    if (data.length === 0) {
      fail_gracefully(`EMPTYRESULTS`);
      return;
    }

    const validate_results = function(data) {
      if (data.length === 1) {
        return true;
      }

      const val0 = String(data[0].confidence).substring(0, 4);
      const val1 = String(data[1].confidence).substring(0, 4);

      if (val0 - val1 > 0.2) {
        return true;
      }
      return false;
    };

    // if the first result has a high enough confidence, or the distance
    // to the second large enough just
    // use it directly.
    data.sort(function(a, b) {
      return b.confidence - a.confidence;
    });
    if (validate_results(data)) {
      var event = new CustomEvent("speech-recognition", {
        detail: data[0].text
      });
      document.dispatchEvent(event);
      var voiceText = document.querySelector("#voiceText");
      if (voiceText) {
        voiceText.setAttribute("scale", ".3 .3 .3");
        voiceText.setAttribute("color", "green");
        voiceText.setAttribute("value", data[0].text);
        setTimeout(() => {
          voiceText.setAttribute("scale", "0 0 0");
        }, 1500);
      }
      if (document.querySelector("#microPhone")) {
        document.querySelector("#microPhone").setAttribute("src", "#micro-off");
      }
      metrics.end_attempt(data[0].confidence, "default accepted", 0);
      metrics.end_session();
      SpeakToMePopup.hide();
      return;
    }

    metrics.set_options_displayed();
    SpeakToMePopup.choose_item(data).then(
      input => {
        var event = new CustomEvent("speech-recognition", {
          detail: input.value
        });
        document.dispatchEvent(event);
        var voiceText = document.querySelector("#voiceText");
        if (voiceText) {
          voiceText.setAttribute("scale", ".3 .3 .3");
          voiceText.setAttribute("color", "green");
          voiceText.setAttribute("value", input.value);
          setTimeout(() => {
            voiceText.setAttribute("scale", "0 0 0");
          }, 1500);
        }
        if (document.querySelector("#microPhone")) {
          document
            .querySelector("#microPhone")
            .setAttribute("src", "#micro-off");
        }
        metrics.end_attempt(input.confidence, "accepted", input.idx_suggestion);
        metrics.end_session();
        // Once a choice is made, close the popup.
        SpeakToMePopup.hide();
      },
      id => {
        if (id === "stm-reset-button") {
          metrics.end_attempt(-1, "reset", -1);
          SpeakToMePopup.reset();
          stm_start();
        } else {
          metrics.end_attempt(-1, "rejected", -1);
          metrics.end_session();
          SpeakToMePopup.hide();
        }
      }
    );
  };

  SpeakToMePopup.init();

  const fail_gracefully = errorMsg => {
    if (errorMsg.indexOf("GUM") === 0) {
      errorMsg = "Please enable your microphone to use VRStore-Voice";
    } else if (errorMsg.indexOf("EMPTYRESULTS") === 0) {
      errorMsg = "No results found";
    } else {
      errorMsg = "Sorry, we encountered an error";
    }
    if (document.querySelector("#microPhone")) {
      document
        .querySelector("#microPhone")
        .setAttribute("src", "#micro-failure");
    }
    setTimeout(() => {
      if (document.querySelector("#microPhone")) {
        document.querySelector("#microPhone").setAttribute("src", "#micro-off");
      }
    }, 1500);
    var voiceText = document.querySelector("#voiceText");
    if (voiceText) {
      voiceText.setAttribute("scale", ".3 .3 .3");
      voiceText.setAttribute("color", "red");
      voiceText.setAttribute("value", errorMsg);
      setTimeout(() => {
        voiceText.setAttribute("scale", "0 0 0");
      }, 1500);
    }
    console.log("ERROR: ", errorMsg);
  };

  // Webrtc_Vad integration
  SpeakToMeVad = function SpeakToMeVad() {
    this.webrtc_main = Module.cwrap("main");
    this.webrtc_main();
    this.webrtc_setmode = Module.cwrap("setmode", "number", ["number"]);
    // set_mode defines the aggressiveness degree of the voice activity detection algorithm
    // for more info see: https://github.com/mozilla/gecko/blob/central/media/webrtc/trunk/webrtc/common_audio/vad/vad_core.h#L68
    this.webrtc_setmode(3);
    this.webrtc_process_data = Module.cwrap("process_data", "number", [
      "number",
      "number",
      "number",
      "number",
      "number",
      "number"
    ]);
    // frame length that should be passed to the vad engine. Depends on audio sample rate
    // https://github.com/mozilla/gecko/blob/central/media/webrtc/trunk/webrtc/common_audio/vad/vad_core.h#L106
    this.sizeBufferVad = 480;
    // minimum of voice (in milliseconds) that should be captured to be considered voice
    this.minvoice = 250;
    // max amount of silence (in milliseconds) that should be captured to be considered end-of-speech
    this.maxsilence = 1500;
    // max amount of capturing time (in seconds)
    this.maxtime = 6;

    this.reset = function() {
      this.buffer_vad = new Int16Array(this.sizeBufferVad);
      this.leftovers = 0;
      this.finishedvoice = false;
      this.samplesvoice = 0;
      this.samplessilence = 0;
      this.touchedvoice = false;
      this.touchedsilence = false;
      this.dtantes = Date.now();
      this.dtantesmili = Date.now();
      this.raisenovoice = false;
      this.done = false;
    };

    // function that returns if the specified buffer has silence of speech
    this.isSilence = function(buffer_pcm) {
      // Get data byte size, allocate memory on Emscripten heap, and get pointer
      const nDataBytes = buffer_pcm.length * buffer_pcm.BYTES_PER_ELEMENT;
      const dataPtr = Module._malloc(nDataBytes);
      // Copy data to Emscripten heap (directly accessed from Module.HEAPU8)
      const dataHeap = new Uint8Array(
        Module.HEAPU8.buffer,
        dataPtr,
        nDataBytes
      );
      dataHeap.set(new Uint8Array(buffer_pcm.buffer));
      // Call function and get result
      const result = this.webrtc_process_data(
        dataHeap.byteOffset,
        buffer_pcm.length,
        48000,
        buffer_pcm[0],
        buffer_pcm[100],
        buffer_pcm[2000]
      );
      // Free memory
      Module._free(dataHeap.byteOffset);
      return result;
    };

    this.floatTo16BitPCM = function(output, input) {
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    };

    this.recorderProcess = function(e) {
      const buffer_pcm = new Int16Array(e.inputBuffer.getChannelData(0).length);
      stm_vad.floatTo16BitPCM(buffer_pcm, e.inputBuffer.getChannelData(0));
      // algorithm used to determine if the user stopped speaking or not
      for (
        let i = 0;
        i < Math.ceil(buffer_pcm.length / stm_vad.sizeBufferVad) &&
        !stm_vad.done;
        i++
      ) {
        const start = i * stm_vad.sizeBufferVad;
        let end = start + stm_vad.sizeBufferVad;
        if (start + stm_vad.sizeBufferVad > buffer_pcm.length) {
          // store to the next buffer
          stm_vad.buffer_vad.set(buffer_pcm.slice(start));
          stm_vad.leftovers = buffer_pcm.length - start;
        } else {
          if (stm_vad.leftovers > 0) {
            // we have this.leftovers from previous array
            end = end - this.leftovers;
            stm_vad.buffer_vad.set(
              buffer_pcm.slice(start, end),
              stm_vad.leftovers
            );
            stm_vad.leftovers = 0;
          } else {
            // send to the vad
            stm_vad.buffer_vad.set(buffer_pcm.slice(start, end));
          }
          const vad = stm_vad.isSilence(stm_vad.buffer_vad);
          stm_vad.buffer_vad = new Int16Array(stm_vad.sizeBufferVad);
          const dtdepois = Date.now();
          if (vad === 0) {
            if (stm_vad.touchedvoice) {
              stm_vad.samplessilence += dtdepois - stm_vad.dtantesmili;
              if (stm_vad.samplessilence > stm_vad.maxsilence) {
                stm_vad.touchedsilence = true;
              }
            }
          } else {
            stm_vad.samplesvoice += dtdepois - stm_vad.dtantesmili;
            if (stm_vad.samplesvoice > stm_vad.minvoice) {
              stm_vad.touchedvoice = true;
            }
          }
          stm_vad.dtantesmili = dtdepois;
          if (stm_vad.touchedvoice && stm_vad.touchedsilence) {
            stm_vad.finishedvoice = true;
          }
          if (stm_vad.finishedvoice) {
            stm_vad.done = true;
            stm_vad.goCloud("GoCloud finishedvoice");
          }
          if ((dtdepois - stm_vad.dtantes) / 1000 > stm_vad.maxtime) {
            stm_vad.done = true;
            if (stm_vad.touchedvoice) {
              stm_vad.goCloud("GoCloud timeout");
            } else {
              stm_vad.goCloud("Raise novoice");
              stm_vad.raisenovoice = true;
            }
          }
        }
      }
    };

    this.goCloud = function(why) {
      console.log(why);
      this.stopGum();
      const copy = document.getElementById("stm-content");
      copy.innerHTML = `<div id="stm-listening-text">Processing...</div>`;
      if (document.querySelector("#microPhone")) {
        document
          .querySelector("#microPhone")
          .setAttribute("src", "#micro-processing");
      }
    };
    console.log("speakToMeVad created()");
  };
})();

// Creation of the configuration object
// that will be pick by emscripten module
var Module = {
  preRun: [],
  postRun: [],
  print: (function() {
    return function(text) {
      console.log("[webrtc_vad.js print]", text);
    };
  })(),
  printErr(text) {
    fail_gracefully("[webrtc_vad.js error]", text);
  },
  canvas: (function() {})(),
  setStatus(text) {
    console.log("[webrtc_vad.js status] ", text);
  },
  totalDependencies: 0,
  monitorRunDependencies(left) {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    Module.setStatus(
      left
        ? "Preparing... (" +
            (this.totalDependencies - left) +
            "/" +
            this.totalDependencies +
            ")"
        : "All downloads complete."
    );
  }
};
let stm_vad;
Module.setStatus("Loading webrtc_vad...");
window.onerror = function(event) {
  // TODO: do not warn on ok events like simulating an infinite loop or exitStatus
  Module.setStatus("Exception thrown, see JavaScript console");
  Module.setStatus = function(text) {
    if (text) {
      Module.printErr("[post-exception status] " + text);
    }
  };
};
Module.noInitialRun = true;
Module["onRuntimeInitialized"] = function() {
  stm_vad = new SpeakToMeVad();
  Module.setStatus("Webrtc_vad and SpeakToMeVad loaded");
};

var blobToBase64 = function(blob, callback) {
  var reader = new window.FileReader();
  reader.onloadend = function() {
    var dataUrl = reader.result;
    var base64 = dataUrl.split(",")[1];
    callback(base64);
  };
  reader.readAsDataURL(blob);
};
