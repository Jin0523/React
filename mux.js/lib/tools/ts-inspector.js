/**
 * mux.js
 *
 * Copyright (c) 2016 Brightcove
 * All rights reserved.
 *
 * Parse mpeg2 transport stream packets to extract basic timing information
 */
'use strict';

var StreamTypes = require('../m2ts/stream-types.js');
var handleRollover = require('../m2ts/timestamp-rollover-stream.js').handleRollover;
var probe = {};
probe.ts = require('../m2ts/probe.js');
probe.aac = require('../aac/utils.js');


var
  PES_TIMESCALE = 90000,
  MP2T_PACKET_LENGTH = 188, // bytes
  SYNC_BYTE = 0x47;

/**
 * walks through segment data looking for pat and pmt packets to parse out
 * program map table information
 */
var parsePsi_ = function(bytes, pmt) {
  var
    startIndex = 0,
    endIndex = MP2T_PACKET_LENGTH,
    packet, type;

  while (endIndex < bytes.byteLength) {
    // Look for a pair of start and end sync bytes in the data..
    if (bytes[startIndex] === SYNC_BYTE && bytes[endIndex] === SYNC_BYTE) {
      // We found a packet
      packet = bytes.subarray(startIndex, endIndex);
      type = probe.ts.parseType(packet, pmt.pid);

      switch (type) {
        case 'pat':
          if (!pmt.pid) {
            pmt.pid = probe.ts.parsePat(packet);
          }
          break;
        case 'pmt':
          if (!pmt.table) {
            pmt.table = probe.ts.parsePmt(packet);
          }
          break;
        default:
          break;
      }

      // Found the pat and pmt, we can stop walking the segment
      if (pmt.pid && pmt.table) {
        return;
      }

      startIndex += MP2T_PACKET_LENGTH;
      endIndex += MP2T_PACKET_LENGTH;
      continue;
    }

    // If we get here, we have somehow become de-synchronized and we need to step
    // forward one byte at a time until we find a pair of sync bytes that denote
    // a packet
    startIndex++;
    endIndex++;
  }
};

/**
 * walks through the segment data from the start and end to get timing information
 * for the first and last audio pes packets
 */
var parseAudioPes_ = function(bytes, pmt, result) {
  var
    startIndex = 0,
    endIndex = MP2T_PACKET_LENGTH,
    packet, type, pesType, pusi, parsed;

  var endLoop = false;

  // Start walking from start of segment to get first audio packet
  while (endIndex <= bytes.byteLength) {
    // Look for a pair of start and end sync bytes in the data..
    if (bytes[startIndex] === SYNC_BYTE &&
        (bytes[endIndex] === SYNC_BYTE || endIndex === bytes.byteLength)) {
      // We found a packet
      packet = bytes.subarray(startIndex, endIndex);
      type = probe.ts.parseType(packet, pmt.pid);

      switch (type) {
        case 'pes':
          pesType = probe.ts.parsePesType(packet, pmt.table);
          pusi = probe.ts.parsePayloadUnitStartIndicator(packet);
          if (pesType === 'audio' && pusi) {
            parsed = probe.ts.parsePesTime(packet);
            if (parsed) {
              parsed.type = 'audio';
              result.audio.push(parsed);
              endLoop = true;
            }
          }
          break;
        default:
          break;
      }

      if (endLoop) {
        break;
      }

      startIndex += MP2T_PACKET_LENGTH;
      endIndex += MP2T_PACKET_LENGTH;
      continue;
    }

    // If we get here, we have somehow become de-synchronized and we need to step
    // forward one byte at a time until we find a pair of sync bytes that denote
    // a packet
    startIndex++;
    endIndex++;
  }

  // Start walking from end of segment to get last audio packet
  endIndex = bytes.byteLength;
  startIndex = endIndex - MP2T_PACKET_LENGTH;
  endLoop = false;
  while (startIndex >= 0) {
    // Look for a pair of start and end sync bytes in the data..
    if (bytes[startIndex] === SYNC_BYTE &&
        (bytes[endIndex] === SYNC_BYTE || endIndex === bytes.byteLength)) {
      // We found a packet
      packet = bytes.subarray(startIndex, endIndex);
      type = probe.ts.parseType(packet, pmt.pid);

      switch (type) {
        case 'pes':
          pesType = probe.ts.parsePesType(packet, pmt.table);
          pusi = probe.ts.parsePayloadUnitStartIndicator(packet);
          if (pesType === 'audio' && pusi) {
            parsed = probe.ts.parsePesTime(packet);
            if (parsed) {
              parsed.type = 'audio';
              result.audio.push(parsed);
              endLoop = true;
            }
          }
          break;
        default:
          break;
      }

      if (endLoop) {
        break;
      }

      startIndex -= MP2T_PACKET_LENGTH;
      endIndex -= MP2T_PACKET_LENGTH;
      continue;
    }

    // If we get here, we have somehow become de-synchronized and we need to step
    // forward one byte at a time until we find a pair of sync bytes that denote
    // a packet
    startIndex--;
    endIndex--;
  }
};

/**
 * walks through the segment data from the start and end to get timing information
 * for the first and last video pes packets as well as timing information for the first
 * key frame.
 */
var parseVideoPes_ = function(bytes, pmt, result) {
  var
    startIndex = 0,
    endIndex = MP2T_PACKET_LENGTH,
    packet, type, pesType, pusi, parsed, frame, i, pes;

  var endLoop = false;

  var currentFrame = {
    data: [],
    size: 0
  };

  // Start walking from start of segment to get first video packet
  while (endIndex < bytes.byteLength) {
    // Look for a pair of start and end sync bytes in the data..
    if (bytes[startIndex] === SYNC_BYTE && bytes[endIndex] === SYNC_BYTE) {
      // We found a packet
      packet = bytes.subarray(startIndex, endIndex);
      type = probe.ts.parseType(packet, pmt.pid);

      switch (type) {
        case 'pes':
          pesType = probe.ts.parsePesType(packet, pmt.table);
          pusi = probe.ts.parsePayloadUnitStartIndicator(packet);
          if (pesType === 'video') {
            if (pusi && !endLoop) {
              parsed = probe.ts.parsePesTime(packet);
              if (parsed) {
                parsed.type = 'video';
                result.video.push(parsed);
                endLoop = true;
              }
            }
            if (!result.firstKeyFrame) {
              if (pusi) {
                if (currentFrame.size !== 0) {
                  frame = new Uint8Array(currentFrame.size);
                  i = 0;
                  while (currentFrame.data.length) {
                    pes = currentFrame.data.shift();
                    frame.set(pes, i);
                    i += pes.byteLength;
                  }
                  if (probe.ts.videoPacketContainsKeyFrame(frame)) {
                    result.firstKeyFrame = probe.ts.parsePesTime(frame);
                    result.firstKeyFrame.type = 'video';
                  }
                  currentFrame.size = 0;
                }
              }
              currentFrame.data.push(packet);
              currentFrame.size += packet.byteLength;
            }
          }
          break;
        default:
          break;
      }

      if (endLoop && result.firstKeyFrame) {
        break;
      }

      startIndex += MP2T_PACKET_LENGTH;
      endIndex += MP2T_PACKET_LENGTH;
      continue;
    }

    // If we get here, we have somehow become de-synchronized and we need to step
    // forward one byte at a time until we find a pair of sync bytes that denote
    // a packet
    startIndex++;
    endIndex++;
  }

  // Start walking from end of segment to get last video packet
  endIndex = bytes.byteLength;
  startIndex = endIndex - MP2T_PACKET_LENGTH;
  endLoop = false;
  while (startIndex >= 0) {
    // Look for a pair of start and end sync bytes in the data..
    if (bytes[startIndex] === SYNC_BYTE && bytes[endIndex] === SYNC_BYTE) {
      // We found a packet
      packet = bytes.subarray(startIndex, endIndex);
      type = probe.ts.parseType(packet, pmt.pid);

      switch (type) {
        case 'pes':
          pesType = probe.ts.parsePesType(packet, pmt.table);
          pusi = probe.ts.parsePayloadUnitStartIndicator(packet);
          if (pesType === 'video' && pusi) {
              parsed = probe.ts.parsePesTime(packet);
              if (parsed) {
                parsed.type = 'video';
                result.video.push(parsed);
                endLoop = true;
              }
          }
          break;
        default:
          break;
      }

      if (endLoop) {
        break;
      }

      startIndex -= MP2T_PACKET_LENGTH;
      endIndex -= MP2T_PACKET_LENGTH;
      continue;
    }

    // If we get here, we have somehow become de-synchronized and we need to step
    // forward one byte at a time until we find a pair of sync bytes that denote
    // a packet
    startIndex--;
    endIndex--;
  }
};

/**
 * Adjusts the timestamp information for the segment to account for
 * rollover and convert to seconds based on pes packet timescale (90khz clock)
 */
var adjustTimestamp_ = function(segmentInfo, baseTimestamp) {
  if (segmentInfo.audio && segmentInfo.audio.length) {
    var audioBaseTimestamp = baseTimestamp;
    if (typeof audioBaseTimestamp === 'undefined') {
      audioBaseTimestamp = segmentInfo.audio[0].dts;
    }
    segmentInfo.audio.forEach(function(info) {
      info.dts = handleRollover(info.dts, audioBaseTimestamp);
      info.pts = handleRollover(info.pts, audioBaseTimestamp);
      // time in seconds
      info.dtsTime = info.dts / PES_TIMESCALE;
      info.ptsTime = info.pts / PES_TIMESCALE;
    });
  }

  if (segmentInfo.video && segmentInfo.video.length) {
    var videoBaseTimestamp = baseTimestamp;
    if (typeof videoBaseTimestamp === 'undefined') {
      videoBaseTimestamp = segmentInfo.video[0].dts;
    }
    segmentInfo.video.forEach(function(info) {
      info.dts = handleRollover(info.dts, videoBaseTimestamp);
      info.pts = handleRollover(info.pts, videoBaseTimestamp);
      // time in seconds
      info.dtsTime = info.dts / PES_TIMESCALE;
      info.ptsTime = info.pts / PES_TIMESCALE;
    });
    if (segmentInfo.firstKeyFrame) {
      var frame = segmentInfo.firstKeyFrame;
      frame.dts = handleRollover(frame.dts, videoBaseTimestamp);
      frame.pts = handleRollover(frame.pts, videoBaseTimestamp);
      // time in seconds
      frame.dtsTime = frame.dts / PES_TIMESCALE;
      frame.ptsTime = frame.dts / PES_TIMESCALE;
    }
  }
};

/**
 * inspects the aac data stream for start and end time information
 */
var inspectAac_ = function(bytes) {
  var
    endLoop = false,
    audioCount = 0,
    sampleRate = null,
    timestamp = null,
    frameSize = 0,
    byteIndex = 0,
    packet;

  while (bytes.length - byteIndex >= 3) {
    var type = probe.aac.parseType(bytes, byteIndex);
    switch (type) {
      case 'timed-metadata':
        // Exit early because we don't have enough to parse
        // the ID3 tag header
        if (bytes.length - byteIndex < 10) {
          endLoop = true;
          break;
        }

        frameSize = probe.aac.parseId3TagSize(bytes, byteIndex);

        // Exit early if we don't have enough in the buffer
        // to emit a full packet
        if (frameSize > bytes.length) {
          endLoop = true;
          break;
        }
        if (timestamp === null) {
          packet = bytes.subarray(byteIndex, byteIndex + frameSize);
          timestamp = probe.aac.parseAacTimestamp(packet);
        }
        byteIndex += frameSize;
        break;
      case 'audio':
        // Exit early because we don't have enough to parse
        // the ADTS frame header
        if (bytes.length - byteIndex < 7) {
          endLoop = true;
          break;
        }

        frameSize = probe.aac.parseAdtsSize(bytes, byteIndex);

        // Exit early if we don't have enough in the buffer
        // to emit a full packet
        if (frameSize > bytes.length) {
          endLoop = true;
          break;
        }
        if (sampleRate === null) {
          packet = bytes.subarray(byteIndex, byteIndex + frameSize);
          sampleRate = probe.aac.parseSampleRate(packet);
        }
        audioCount++;
        byteIndex += frameSize;
        break;
      default:
        byteIndex++;
        break;
    }
    if (endLoop) {
      return null;
    }
  }
  if (sampleRate === null || timestamp === null) {
    return null;
  }

  var audioTimescale = PES_TIMESCALE / sampleRate;

  var result = {
    audio: [
      {
        type: 'audio',
        dts: timestamp,
        pts: timestamp
      },
      {
        type: 'audio',
        dts: timestamp + (audioCount * 1024 * audioTimescale),
        pts: timestamp + (audioCount * 1024 * audioTimescale)
      }
    ]
  };

  return result;
};

/**
 * inspects the transport stream segment data for start and end time information
 * of the audio and video tracks (when present) as well as the first key frame's
 * start time.
 */
var inspectTs_ = function(bytes) {
  var pmt = {
    pid: null,
    table: null
  };

  var result = {};

  parsePsi_(bytes, pmt);

  for (var pid in pmt.table) {
    if (pmt.table.hasOwnProperty(pid)) {
      var type = pmt.table[pid];
      switch (type) {
        case StreamTypes.H264_STREAM_TYPE:
          result.video = [];
          parseVideoPes_(bytes, pmt, result);
          if (result.video.length === 0) {
            delete result.video;
          }
          break;
        case StreamTypes.ADTS_STREAM_TYPE:
          result.audio = [];
          parseAudioPes_(bytes, pmt, result);
          if (result.audio.length === 0) {
            delete result.audio;
          }
          break;
        default:
          break;
      }
    }
  }
  return result;
};

/**
 * Inspects segment byte data and returns an object with start and end timing information
 *
 * @param {Uint8Array} bytes The segment byte data
 * @param {Number} baseTimestamp Relative reference timestamp used when adjusting frame
 *  timestamps for rollover. This value must be in 90khz clock.
 * @return {Object} Object containing start and end frame timing info of segment.
 */
var inspect = function(bytes, baseTimestamp) {
  var isAacData = probe.aac.isLikelyAacData(bytes);

  var result;

  if (isAacData) {
    result = inspectAac_(bytes);
  } else {
    result = inspectTs_(bytes);
  }

  if (!result || (!result.audio && !result.video)) {
    return null;
  }

  adjustTimestamp_(result, baseTimestamp);

  return result;
};

module.exports = {
  inspect: inspect,
  parseAudioPes_: parseAudioPes_
};
