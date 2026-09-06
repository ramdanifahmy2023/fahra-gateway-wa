import assert from "node:assert/strict";
import test from "node:test";

import {
  parseImageStatusRequest,
  parseTextStatusRequest,
  parseVideoStatusRequest,
} from "../src/health-server.js";

void test("text status request applies safe defaults", () => {
  assert.deepEqual(parseTextStatusRequest({ text: "  Tes status  " }), {
    text: "Tes status",
    backgroundColor: "#25D366",
    font: 1,
  });
});

void test("video status request accepts only generated MP4 names", () => {
  assert.deepEqual(
    parseVideoStatusRequest({
      filePath: "123e4567-e89b-12d3-a456-426614174000.mp4",
      mimeType: "video/mp4",
      caption: "  Sore dulu  ",
    }),
    {
      filePath: "123e4567-e89b-12d3-a456-426614174000.mp4",
      mimeType: "video/mp4",
      caption: "Sore dulu",
    },
  );
  assert.throws(
    () => parseVideoStatusRequest({ filePath: "/tmp/video.mp4", mimeType: "video/mp4" }),
    /gateway-generated/,
  );
});

void test("text status request validates text, color, and font", () => {
  assert.throws(() => parseTextStatusRequest({ text: "" }), /1-700/);
  assert.throws(
    () => parseTextStatusRequest({ text: "Tes", backgroundColor: "green" }),
    /#RRGGBB/,
  );
  assert.throws(
    () => parseTextStatusRequest({ text: "Tes", font: 6 }),
    /between 0 and 5/,
  );
});

void test("image status request accepts only generated image names", () => {
  assert.deepEqual(
    parseImageStatusRequest({
      filePath: "123e4567-e89b-12d3-a456-426614174000.jpg",
      mimeType: "image/jpeg",
      caption: "  Pap Fahra  ",
    }),
    {
      filePath: "123e4567-e89b-12d3-a456-426614174000.jpg",
      mimeType: "image/jpeg",
      caption: "Pap Fahra",
    },
  );
  assert.throws(
    () => parseImageStatusRequest({ filePath: "/tmp/photo.jpg", mimeType: "image/jpeg" }),
    /gateway-generated/,
  );
  assert.throws(
    () => parseImageStatusRequest({ filePath: "123e4567-e89b-12d3-a456-426614174000.svg", mimeType: "image/svg+xml" }),
    /gateway-generated/,
  );
});
