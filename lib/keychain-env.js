'use strict';

const { execSync } = require('child_process');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const plistparser = require('plist');
const util = require('util');
const keychainenv = {};

/**
 * Converts a string full of hex bytes (e.g. 'EA93F037') into a string
 * comprised of those same bytes. The encoding of the string is assumed
 * to be utf-8.
 *
 * @param {String} hexString The string to decode.
 * @returns {String} The decoded string.
 */
const decodeHex = function (hexString) {
  const uint8 = new Uint8Array(hexString.length / 2);

  for (let i = 0; i < hexString.length; i += 2) {
    const hexByte = hexString.slice(i, i + 2);
    const byte = parseInt(hexByte, 16);

    uint8[i / 2] = byte;
  }

  const buffer = Buffer.from(uint8);

  return buffer.toString();
};

/**
 * Extracts the `NOTE` field from the property list retrieved from the
 * keychain. For more info on property lists.
 * @see https://en.wikipedia.org/wiki/Property_list
 *
 * @param {String} plistString The propert list to extract the note from.
 * @returns {String} The extracted note.
 */
const noteFromPList = function (plistString) {
  //  Secure notes in the keychain come back in two different formats.
  //  1. If they were entered via `Keychain Access.app` then they come
  //     back to us as an Apple property list XML file.
  const plistPreamble = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
  if (plistString.indexOf(plistPreamble) >= 0) {
    const p = plistparser.parse(plistString);
    const note = p.NOTE;

    return note;
  }

  //  2. However, ones that were entered programmatically seem to always
  //     come back as just the raw note contents without the plist wrapper
  //     around them. So, just return it as-is.
  return plistString;
};

/**
 * Takes a string and replaces all occurances of `"` with `\"`.
 *
 * @param {String} str The string whose double-quotes should be escaped.
 * @returns {String} The escaped string.
 */
const escapeDoubleQuotes = function (str) {
  return str.replace(/\\([\s\S])|(")/g, "\\$1$2");
};

/**
 * Writes a secure note to the macOS keychain. The options object can
 * be used to control several aspects of the write.
 *
 * If neither `options.template` nor `options.templatePath` are specified
 * then no action is taken. If both are provided then `options.template` wins.
 *
 * @param {String} noteName The name to use for the new note.
 * @param {Object} options The options to use when writing the note.
 * @param {Number} options.timeout The maximum amount of time, in milliseconds,
 *    to wait for the write operation to finish.
 * @param {String} options.template The full textual contents of the note to
 *    write to the keychain.
 * @param {String} options.templatePath The full or relative path to a file
 *    on disk whose contents should be used as the text for the note.
 */
const writeNote = function (noteName, options) {
  let contents;

  if (options.template) {
    contents = options.template;
  } else if (options.templatePath) {
    contents = fs.readFileSync(options.templatePath).toString();
  } else {
    //  If neither then just return without writing a template.
    return;
  }

  //  We're using double-quotes around our arguments in the shell command
  //  so escape any that might be present in the note contents.
  contents = escapeDoubleQuotes(contents);

  //  From `man security`
  //  -C note        : Specify the type of object we want
  //  -D <kind>      : A description of the contents of the note
  //  -s <note name> : The name of the note
  //  -a ''          : An account name is required by the command,
  //                   but is not used by notes
  //  -w <note>      : The note contents
  const cmd = util.format('/usr/bin/security add-generic-password -D "secure note" -C note -a "" -s "%s" -w "%s"',
    noteName, contents);

  try {
    execSync(cmd, { timeout: options.timeout });
  } catch (e) {
    throw e;
  }
};

/**
 * Sets the node process environment variables based on the contents
 * of a secure note stored in the macOS keychain. If the note is not
 * found there is the option to write a placeholder based on a template.
 *
 * In the case of errors an `Error` will be thrown.
 *
 * @param {String} noteName The name of the note to read.
 * @param {Object} [options={}] The options to use when reading the note.
 * @param {Bool} options.overwrite If `false` then existing environment
 *    variables will not be overwritten. If `true` they will be.
 * @param {Number} options.timeout The maximum amount of time, in milliseconds,
 *    to wait for the read operation to finish. The default is 5 seconds.
 * @param {String} options.template If the note is not found you may
 *    specify the contents of a placeholder in this field and it will be
 *    written to a new note with the given name.
 * @param {String} options.templatePath If the note is not found you may
 *    specify a path to a file on disk and its contents will be written to
 *    a new note with the given name.
 */
keychainenv.setEnvFromNote = function (noteName, options={}) {
  if (!noteName) {
    throw new Error('You must supply a note name');
  }

  //  Follow dotenv's lead and don't overwrite any existing
  //  variables by defalt.
  if (options.overwrite === undefined) {
    options.overwrite = false;
  }

  //  Give the read operation 5 seconds by default;
  if (options.timeout === undefined) {
    options.timeout = 5000;
  }

  //  From `man security`
  //  -C note        : Specify the type of object we want
  //  -s <note name> : The name of the note
  //  -w             : Return the note without metadata
  const cmd = util.format('/usr/bin/security find-generic-password -C note -s "%s" -w', noteName);

  let stdout;

  try {
    stdout = execSync(cmd, { timeout: options.timeout });
  }
  catch (e) {
    if (e.status === 44) {
      //  44 is the status when there is no note with the given name.
      if (options.template === undefined && options.templatePath === undefined) {
        throw e;
      }
    } else {
      throw e;
    }
  }

  //  Either we have a note to parse and apply or we need to try to write
  //  a template.
  if (stdout) {
    //  The output is in hex-string format.
    const plist = decodeHex(stdout);

    //  We've converted the hex-string block to a plist. Get the note.
    const note = noteFromPList(plist);

    //  Parse the note and convert it to a simple js object.
    const vars = dotenv.parse(note);

    //  Set all the variables defined in the note.
    for (const k of Object.keys(vars)) {
      if (process.env[k] !== undefined) {
        if (! options.overwrite) {
          continue;
        }
      }

      process.env[k] = vars[k];
    }
  } else {
    writeNote(noteName, options);
  }
};

module.exports = keychainenv;
