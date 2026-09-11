import { strict as assert } from "node:assert";
import { test } from "node:test";
import { describeSilence, parsePactlSources } from "../mic.ts";
import { peakRawPcm16Le } from "../wav.ts";

const PACTL = `62\talsa_output.usb-Generic_USB_Audio-00.HiFi__SPDIF__sink.monitor\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED
5579\talsa_input.usb-DJI_Technology_Co.__Ltd._Wireless_Mic_Rx_XSP12345678B-01.analog-stereo\tPipeWire\ts24le 2ch 48000Hz\tRUNNING
66\talsa_input.usb-Generic_USB_Audio-00.HiFi__Mic__source\tPipeWire\ts24le 2ch 48000Hz\tSUSPENDED`;

test("parsePactlSources keeps real inputs, drops monitors and marks the default", () => {
  const devices = parsePactlSources(PACTL, "alsa_input.usb-DJI_Technology_Co.__Ltd._Wireless_Mic_Rx_XSP12345678B-01.analog-stereo");
  assert.equal(devices.length, 2);
  assert.ok(devices.every((device) => !device.name.endsWith(".monitor")));
  assert.equal(devices[0]?.isDefault, true);
  assert.equal(devices[1]?.isDefault, false);
  assert.match(devices[0]?.description ?? "", /PipeWire/);
});

test("parsePactlSources tolerates empty output", () => {
  assert.deepEqual(parsePactlSources("", ""), []);
});

test("describeSilence names the default input and the alternatives", () => {
  const text = describeSilence({
    peak: 0,
    defaultSource: "alsa_input.usb-DJI_Mic",
    devices: [
      { name: "alsa_input.usb-DJI_Mic", description: "", isDefault: true },
      { name: "alsa_input.usb-Generic_Mic", description: "", isDefault: false },
    ],
  });
  assert.match(text, /alsa_input\.usb-DJI_Mic/);
  assert.match(text, /peak 0/);
  assert.match(text, /alsa_input\.usb-Generic_Mic/);
  assert.match(text, /pactl set-default-source/);
});

test("describeSilence says so when there is no alternative", () => {
  const text = describeSilence({ peak: 0, defaultSource: "only", devices: [{ name: "only", description: "", isDefault: true }] });
  assert.match(text, /no other input device/);
});

test("describeSilence degrades gracefully without pactl", () => {
  const text = describeSilence({ peak: 0, defaultSource: "", devices: [] });
  assert.match(text, /no other input device/);
});

test("peakRawPcm16Le measures headerless PCM", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(-12345, 2);
  pcm.writeInt16LE(10, 4);
  pcm.writeInt16LE(0, 6);
  assert.equal(peakRawPcm16Le(pcm), 12345);
  assert.equal(peakRawPcm16Le(Buffer.alloc(0)), 0);
});
