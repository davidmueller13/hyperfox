/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the nsSessionStore component.
 *
 * The Initial Developer of the Original Code is
 * Simon Bünzli <zeniko@gmail.com>
 *
 * Portions created by the Initial Developer are Copyright (C) 2006
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 * Dietrich Ayala <autonome@gmail.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * Session Storage and Restoration
 * 
 * Overview
 * This service user's session file at startup, and makes a determination as to
 * whether the session should be restored. It fill restore the session under 
 * the circumstances described below.
 * 
 * Crash Detection
 * The initial segment of the INI file is has a single field, "state", that 
 * indicates whether the browser is currently running. When the browser shuts 
 * down, the field is changed to "stopped". At startup, this field is read, and
 * if it's value is "running", then it's assumed that the browser had previously
 * crashed, or at the very least that something bad happened, and that we should
 * restore the session.
 * 
 * Forced Restarts
 * In the event that a restart is required due to application update or extension
 * installation, set the browser.sessionstore.resume_session_once pref to true,
 * and the session will be restored the next time the browser starts.
 * 
 * Always Resume
 * This service will always resume the session if the boolean pref 
 * browser.sessionstore.resume_session is set to true.
 */

/* :::::::: Constants and Helpers ::::::::::::::: */

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

const CID = Components.ID("{ec7a6c20-e081-11da-8ad9-0800200c9a66}");
const CONTRACT_ID = "@mozilla.org/browser/sessionstartup;1";
const CLASS_NAME = "Browser Session Startup Service";

const STATE_STOPPED = 0;
const STATE_RUNNING = 1;
const STATE_QUITTING = -1;

const STATE_STOPPED_STR = "stopped";
const STATE_RUNNING_STR = "running";

/* :::::::: Pref Defaults :::::::::::::::::::: */

// whether the service is enabled
const DEFAULT_ENABLED = true;

// resume the current session at startup (otherwise just recover)
const DEFAULT_RESUME_SESSION = false;

// resume the current session at startup just this once
const DEFAULT_RESUME_SESSION_ONCE = false;

// resume the current session at startup if it had previously crashed
const DEFAULT_RESUME_FROM_CRASH = true;

function debug(aMsg) {
  aMsg = ("SessionStartup: " + aMsg).replace(/\S{80}/g, "$&\n");
  Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService)
                                     .logStringMessage(aMsg);
}

/* :::::::: The Service ::::::::::::::: */

function SessionStartup() {
}

SessionStartup.prototype = {

  // set default load state
  _loadState: STATE_STOPPED,

/* ........ Global Event Handlers .............. */

  /**
   * Initialize the component
   */
  init: function sss_init() {
    debug("startup init");
    this._prefBranch = Cc["@mozilla.org/preferences-service;1"].
                       getService(Ci.nsIPrefService).
                       getBranch("browser.");
    this._prefBranch.QueryInterface(Ci.nsIPrefBranch2);

    // if the service is disabled, do not init 
    if (!this._getPref("sessionstore.enabled", DEFAULT_ENABLED))
      return;

    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);
    
    // get file references
    var dirService = Cc["@mozilla.org/file/directory_service;1"].
                     getService(Ci.nsIProperties);
    this._sessionFile = dirService.get("ProfD", Ci.nsILocalFile);
    this._sessionFileBackup = this._sessionFile.clone();
    this._sessionFile.append("sessionstore.ini");
    this._sessionFileBackup.append("sessionstore.bak");
   
    // only read the session file if config allows possibility of restoring
    var resumeFromCrash = this._getPref("sessionstore.resume_from_crash", DEFAULT_RESUME_FROM_CRASH);
    if (resumeFromCrash || this._doResumeSession()) {
      // get string containing session state
      this._iniString = this._readFile(this._getSessionFile());
      if (this._iniString) {
        try {
          // parse the session state into JS objects
          this._initialState = IniObjectSerializer.decode(this._iniString);
          // set bool detecting crash
          this._lastSessionCrashed =
            this._initialState.Session && this._initialState.Session.state &&
            this._initialState.Session.state == STATE_RUNNING_STR;
        // invalid .INI file - nothing can be restored
        }
        catch (ex) { debug("The session file is invalid: " + ex); } 
      }
    }
    
    // prompt and check prefs
    this._doRestore = this._lastSessionCrashed ? this._doRecoverSession() : this._doResumeSession();
    if (this._initialState && !this._doRestore) {
      delete this._iniString; // delete state string
      delete this._initialState; // delete state
    }
    if (this._getPref("sessionstore.resume_session_once", DEFAULT_RESUME_SESSION_ONCE)) {
      this._prefBranch.setBoolPref("sessionstore.resume_session_once", false);
    }
  },

  /**
   * Handle notifications
   */
  observe: function sss_observe(aSubject, aTopic, aData) {
    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);

    // for event listeners
    var _this = this;

    switch (aTopic) {
    case "app-startup": 
      observerService.addObserver(this, "final-ui-startup", true);
      break;
    case "final-ui-startup": 
      observerService.removeObserver(this, "final-ui-startup");
      this.init();
      break;
    }
  },

/* ........ Public API ................*/

  /**
   * Get the session state as a string
   */
  get state() {
    return this._iniString;
  },

  /**
   * Determine if session should be restored
   * @returns bool
   */
  doRestore: function sss_doRestore() {
    return this._doRestore;
  },

/* ........ Disk Access .............. */

  /**
   * get session datafile (or its backup)
   * @returns nsIFile 
   */
  _getSessionFile: function sss_getSessionFile(aBackup) {
    return aBackup ? this._sessionFileBackup : this._sessionFile;
  },

/* ........ Auxiliary Functions .............. */

  /**
   * Whether or not to resume session, if not recovering from a crash
   * Returns true if:
   * - pref is set to always resume sessions
   * - pref is set to resume session once
   * - user configured startup page to be the last-visited page
   * @returns bool
   */
  _doResumeSession: function sss_doResumeSession() {
    return this._getPref("sessionstore.resume_session", DEFAULT_RESUME_SESSION) || 
      this._getPref("sessionstore.resume_session_once", DEFAULT_RESUME_SESSION_ONCE) || 
      this._getPref("startup.page", 1) == 2;
  },

  /**
   * prompt user whether or not to restore the previous session,
   * if the browser crashed
   * @returns bool
   */
  _doRecoverSession: function sss_doRecoverSession() {
    // do not prompt or resume, post-crash
    if (!this._getPref("sessionstore.resume_from_crash", DEFAULT_RESUME_FROM_CRASH))
      return false;

    // if the prompt fails, recover anyway
    var recover = true;
    // allow extensions to hook in a more elaborate restore prompt
    //zeniko: drop this when we're using our own dialog instead of a standard prompt
    var dialogURI = this._getPref("sessionstore.restore_prompt_uri");
    
    try {
      if (dialogURI) { // extension provided dialog 
        var params = Cc["@mozilla.org/embedcomp/dialogparam;1"].
                     createInstance(Ci.nsIDialogParamBlock);
        // default to recovering
        params.SetInt(0, 0);
        Cc["@mozilla.org/embedcomp/window-watcher;1"].
        getService(Ci.nsIWindowWatcher).
        openWindow(null, dialogURI, "_blank", 
                   "chrome,modal,centerscreen,titlebar", params);
        recover = params.GetInt(0) == 0;
      }
      else { // basic prompt with no options
        // get app name from branding properties
        var brandStringBundle = this._getStringBundle("chrome://branding/locale/brand.properties");
        var brandShortName = brandStringBundle.GetStringFromName("brandShortName");

        // create prompt strings
        var ssStringBundle = this._getStringBundle("chrome://browser/locale/sessionstore.properties");
        var restoreTitle = ssStringBundle.formatStringFromName("restoreTitle", [brandShortName], 1);
        var restoreText = ssStringBundle.formatStringFromName("restoreText", [brandShortName], 1);
        var buttonTitle = ssStringBundle.GetStringFromName("buttonTitle");

        var promptService = Cc["@mozilla.org/embedcomp/prompt-service;1"].
                            getService(Ci.nsIPromptService);

        // set the buttons that will appear on the dialog
        var flags = promptService.BUTTON_TITLE_IS_STRING * promptService.BUTTON_POS_1 +
                    promptService.BUTTON_TITLE_CANCEL * promptService.BUTTON_POS_0;
        
        var buttonChoice = promptService.confirmEx(null, restoreTitle, restoreText, 
                                          flags, null, buttonTitle, null, 
                                          null, {});
        recover = (buttonChoice == 1);
      }
    }
    catch (ex) { dump(ex + "\n"); } // if the prompt fails, recover anyway
    return recover;
  },

  /**
   * Convenience method to get localized string bundles
   * @param aURI
   * @returns nsIStringBundle
   */
  _getStringBundle: function sss_getStringBundle(aURI) {
    var bundleService = Cc["@mozilla.org/intl/stringbundle;1"].
                        getService(Ci.nsIStringBundleService);
    var appLocale = Cc["@mozilla.org/intl/nslocaleservice;1"].
                    getService(Ci.nsILocaleService).getApplicationLocale();
    return bundleService.createBundle(aURI, appLocale);
  },

/* ........ Storage API .............. */

  /**
   * basic pref reader
   * @param aName
   * @param aDefault
   * @param aUseRootBranch
   */
  _getPref: function sss_getPref(aName, aDefault) {
    var pb = this._prefBranch;
    try {
      switch (pb.getPrefType(aName)) {
      case pb.PREF_STRING:
        return pb.getCharPref(aName);
      case pb.PREF_BOOL:
        return pb.getBoolPref(aName);
      case pb.PREF_INT:
        return pb.getIntPref(aName);
      default:
        return aDefault;
      }
    }
    catch(ex) {
      return aDefault;
    }
  },

  /**
   * reads a file into a string
   * @param aFile
   *        nsIFile
   * @returns string
   */
  _readFile: function sss_readFile(aFile) {
    try {
      var stream = Cc["@mozilla.org/network/file-input-stream;1"].
                   createInstance(Ci.nsIFileInputStream);
      stream.init(aFile, 0x01, 0, 0);
      var cvstream = Cc["@mozilla.org/intl/converter-input-stream;1"].
                     createInstance(Ci.nsIConverterInputStream);
      cvstream.init(stream, "UTF-8", 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
      
      var content = "";
      var data = {};
      while (cvstream.readString(4096, data)) {
        content += data.value;
      }
      cvstream.close();
      
      return content.replace(/\r\n?/g, "\n");
    }
    catch (ex) { } // inexisting file?
    
    return null;
  },

/* ........ QueryInterface .............. */

  QueryInterface: function(aIID) {
    if (!aIID.equals(Ci.nsISupports) && !aIID.equals(Ci.nsIObserver) && 
      !aIID.equals(Ci.nsISupportsWeakReference) && 
      !aIID.equals(Ci.nsISessionStartup)) {
      Components.returnCode = Cr.NS_ERROR_NO_INTERFACE;
      return null;
    }
    
    return this;
  }
};

/* :::::::: File Format Converter ::::::::::::::: */

/**
 * Sessions are serialized to and restored from .INI files
 * 
 * The serialization can store nested JS objects and arrays. Each object or array
 * gets a session header containing the "path" to it (using dots as name separators).
 * Arrays are stored as a list of objects where the path name is the array name plus
 * the object's index (e.g. [Window2.Cookies] is the Cookies object of the second entry
 * of the Window array).
 * 
 * The .INI format used here is for performance and convenience reasons somewhat restricted:
 * * files must be stored in a Unicode compatible encoding (such as UTF-8)
 * * section headers and key names are case-sensitive
 * * dots in section names have special meaning (separating the names in the object hierarchy)
 * * numbers can have some special meaning as well (see below)
 * * keys could occur in the "root" section (i.e. before the first section header)
 * 
 * Despite these restrictions, these files should be quite interoperable with other .INI
 * parsers since we're quite conservative in what we emit and pretty tolerant in what we
 * accept (except for the encoding and the case sensitivity issues - which could be
 * remedied by encoding all values containing non US-ASCII characters and by requesting
 * all keys to be lower-cased (and enforcing this when restoring).
 * 
 * Implementation details you have to be aware of:
 * * empty (string) values aren't stored at all
 * * keys beginning with an underscore are ignored
 * * Arrays are stored with index-base 1 (NOT: 0!)
 * * Array lengths are stored implicitely
 * * true and false are (re)stored as boolean values
 * * positive integers are returned as Number (all other numbers as String)
 * * string values can contain all possible characters
 *   (they are automatically URI encoded/decoded should that be necessary)
 */
var IniObjectSerializer = {
  encode: function(aObj, aPrefix) {
    aPrefix = aPrefix ? aPrefix + "." : "";
    
    var ini = [], iniChildren = [];
    
    for (var key in aObj) {
      if (!key || /[;\[\]=]/.test(key)) {
        debug("Ignoring invalid key name: '" + key + "'!");
        continue;
      }
      else if (key.charAt(0) == "_") { // ignore this key
        continue;
      }
      
      var value = aObj[key];
      if (typeof value == "boolean" || typeof value == "number") {
        ini.push(key + "=" + value);
      }
      else if (typeof value == "string" && value) {
        ini.push(key + "=" + (/^\s|[%\t\r\n;]|\s$/.test(value) ? encodeURI(value).replace(/;/g, "%3B") : value));
      }
      else if (value instanceof Array) {
        for (var i = 0; i < value.length; i++) {
          if (value[i] instanceof Object) {
            iniChildren.push("[" + aPrefix + key + (i + 1) + "]");
            iniChildren.push(this.encode(value[i], aPrefix + key + (i + 1)));
          }
        }
      }
      else if (typeof value == "object" && value) {
        iniChildren.push("[" + aPrefix + key + "]");
        iniChildren.push(this.encode(value, aPrefix + key));
      }
    }
    
    return ini.concat(iniChildren).join("\n");
  },

  decode: function(aIniString) {
    var rootObject = {};
    var obj = rootObject;
    var lines = aIniString.split("\n");
    
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/;.*/, "");
      try {
        if (line.charAt(0) == "[") {
          obj = this._getObjForHeader(rootObject, line);
        }
        else if (/\S/.test(line)) { // ignore blank lines
          this._setValueForLine(obj, line);
        }
      }
      catch (ex) {
        throw new Error("Error at line " + (i + 1) + ": " + ex.description);
      }
    }
    
    return rootObject;
  },

  // Object which results after traversing the path indicated in the section header
  _getObjForHeader: function(aObj, aLine) {
    var names = aLine.split("]")[0].substr(1).split(".");
    
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (!names[i]) {
        throw new Error("Invalid header: [" + names.join(".") + "]!");
      }
      if (/(\d+)$/.test(names[i])) {
        names[i] = names[i].slice(0, -RegExp.$1.length);
        var ix = parseInt(RegExp.$1) - 1;
        aObj = aObj[names[i]] = aObj[names[i]] || [];
        aObj = aObj[ix] = aObj[ix] || {};
      }
      else {
        aObj = aObj[names[i]] = aObj[names[i]] || {};
      }
    }
    
    return aObj;
  },

  _setValueForLine: function(aObj, aLine) {
    var ix = aLine.indexOf("=");
    if (ix < 1) {
      throw new Error("Invalid entry: " + aLine + "!");
    }
    
    var key = this._trim(aLine.substr(0, ix));
    var value = this._trim(aLine.substr(ix + 1));
    if (value == "true" || value == "false") {
      value = (value == "true");
    }
    else if (/^\d+$/.test(value)) {
      value = parseInt(value);
    }
    else if (value.indexOf("%") > -1) {
      value = decodeURI(value.replace(/%3B/gi, ";"));
    }
    
    aObj[key] = value;
  },

  _trim: function(aString) {
    return aString.replace(/^\s+|\s+$/g, "");
  }
};

/* :::::::: Service Registration & Initialization ::::::::::::::: */

/* ........ nsIModule .............. */

const SessionStartupModule = {

  getClassObject: function(aCompMgr, aCID, aIID) {
    if (aCID.equals(CID)) {
      return SessionStartupFactory;
    }
    
    Components.returnCode = Cr.NS_ERROR_NOT_REGISTERED;
    return null;
  },

  registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
    aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
    aCompMgr.registerFactoryLocation(CID, CLASS_NAME, CONTRACT_ID, aFileSpec, aLocation, aType);

    var catMan = Cc["@mozilla.org/categorymanager;1"].
                 getService(Ci.nsICategoryManager);
    catMan.addCategoryEntry("app-startup", CLASS_NAME, "service," + CONTRACT_ID, true, true);
  },

  unregisterSelf: function(aCompMgr, aLocation, aType) {
    aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
    aCompMgr.unregisterFactoryLocation(CID, aLocation);

    var catMan = Cc["@mozilla.org/categorymanager;1"].
                 getService(Ci.nsICategoryManager);
    catMan.deleteCategoryEntry( "app-startup", "service," + CONTRACT_ID, true);
  },

  canUnload: function(aCompMgr) {
    return true;
  }
}

/* ........ nsIFactory .............. */

const SessionStartupFactory = {

  createInstance: function(aOuter, aIID) {
    if (aOuter != null) {
      Components.returnCode = Cr.NS_ERROR_NO_AGGREGATION;
      return null;
    }
    
    return (new SessionStartup()).QueryInterface(aIID);
  },

  lockFactory: function(aLock) { },

  QueryInterface: function(aIID) {
    if (!aIID.equals(Ci.nsISupports) && !aIID.equals(Ci.nsIModule) &&
        !aIID.equals(Ci.nsIFactory) && !aIID.equals(Ci.nsISessionStartup)) {
      Components.returnCode = Cr.NS_ERROR_NO_INTERFACE;
      return null;
    }
    
    return this;
  }
};

function NSGetModule(aComMgr, aFileSpec) {
  return SessionStartupModule;
}
