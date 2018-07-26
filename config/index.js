/**
* The Settings Module reads the settings out of settings.json and provides
* this information to the other modules
*/

const fs          = require("fs");
const path        = require("path");
const jsonminify  = require("jsonminify");

module.exports = (function() {
  settingsFilename = './settings.json';

  let settingsStr;
  try {
    settingsStr = fs.readFileSync(path.resolve(__dirname, settingsFilename)).toString();
  } catch(e) {
    console.log(e.message);
    throw new Error('Config Error: settings.json file missing');
  }

  // try to parse the settings
  let settings;
  try {
    if (settingsStr) {
      settingsStr = jsonminify(settingsStr).replace(",]","]").replace(",}","}");
      settings = JSON.parse(settingsStr);
    }
  } catch(e) {
    console.log(e);
    throw new Error('Unable to process settings.json');
  }

  return settings;
})();
