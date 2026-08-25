'use strict';
// VS Code extension test runner entry (extension host side).
const Mocha = require('mocha/lib/mocha');
const path = require('path');

exports.run = async function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  mocha.addFile(path.join(__dirname, 'suite.js'));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => resolve(failures));
    } catch (err) {
      reject(err);
    }
  });
};
