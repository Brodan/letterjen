var fs = require('fs')
var readline = require('readline')
var google = require('googleapis')
var googleAuth = require('google-auth-library')
var chalk = require('chalk');

// If modifying these scopes, delete your previously saved credentials
// at ~/.credentials/letterjen.json
var SCOPES = ['https://www.googleapis.com/auth/documents',
              'https://www.googleapis.com/auth/drive']
var TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH ||
    process.env.USERPROFILE) + '/.credentials/'
var TOKEN_PATH = TOKEN_DIR + 'letterjen.json'
var COMPANY, POSITION

module.exports = {
  authorize: function(){
    readSecrets()
    .then(authorize)
    .then(uploadAppScript)
    .then(result => {
      console.log(chalk.bold.cyan('Auth token stored to ' + TOKEN_PATH))
    })
    .catch(error => {
      console.error(chalk.bold.red('An error occurred: '), error )}) 
  },
  generate: function(company, position){
    COMPANY = company
    POSITION = position
    readSecrets()
    .then(authorize)
    .then(getDoc)
    .then(createDoc)
    .then(callAppsScript)
    .then(downloadLetter)
    .then(result => {
      console.log(chalk.bold.cyan(result))})
    .catch(error => {
      console.error(chalk.bold.red('An error occurred: '), error )})  
  }
}

/**
 * Retrieve client_secret.json file for use with OAuth client.
 */
function readSecrets() {
  return new Promise(function(resolve, reject) {
    fs.readFile('client_secret.json', function (err, content) {
      if (err) {
        reject(Error("Could not read client_secret.json file."))
      }
      else {
        resolve(JSON.parse(content))
      }
    })
  })
}

/**
 * Authorize an OAuth2 client with the given credentials.
 *
 * @param {Object} credentials The authorization client credentials.
 */
function authorize(credentials) {
  var clientSecret = credentials.installed.client_secret
  var clientId = credentials.installed.client_id
  var redirectUrl = credentials.installed.redirect_uris[0]
  var auth = new googleAuth()
  var oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl)

  return new Promise(function(resolve, reject) {
    // Check if we have previously stored a token.
    fs.readFile(TOKEN_PATH, function(err, token) {
      if (err) {
        // Token not found, generate new one.
        resolve(getNewToken(oauth2Client))
      } else {
        oauth2Client.credentials = JSON.parse(token)
        resolve(oauth2Client)
      }
    })
  })
}

/* CURRENTLY BROKEN
 *
 */
function uploadAppScript(auth) {
  return new Promise(function(resolve, reject) {
    var drive = google.drive('v3')
    drive.files.create({
      auth: auth,
      resource: {
        name: 'letterjen',
        mimeType: 'application/vnd.google-apps.script'
      },
      media: {
        mimeType: 'application/vnd.google-apps.script',
        body: fs.createReadStream('src/letterjen.gs')
      }
    }, function(err, result){
      if(err){
        console.log(err)
        reject(Error('Unable to upload app script.'))
      }
      console.log(result.id)
      resolve({auth: auth, fileID: result.id})
    })
  })
}

/**
 * Get and store new token after prompting for user authorization.
 *
 * @param {Object} oauth2Client The OAuth2 client to get token for.
 */
function getNewToken(oauth2Client) {
  return new Promise(function(resolve, reject) {
    var authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES
    })
    console.log('Authorize this app by visiting this url: ', authUrl)
    var rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question('Enter the code from that page here: ', function(code) {
      rl.close()
    
      oauth2Client.getToken(code, function(err, token) {
        if (err) {
          reject(Error("Could not retrieve access token."))
        }
        oauth2Client.credentials = token
        storeToken(token)
        resolve(oauth2Client)
      })
    })
  })
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
function storeToken(token) {
  try {
    fs.mkdirSync(TOKEN_DIR)
  } catch (err) {
    if (err.code != 'EEXIST') {
      throw err
    }
  }
  fs.writeFile(TOKEN_PATH, JSON.stringify(token))
}

/**
 * Retrieve the document ID of the 'Generic Cover Letter' in Google Drive.
 * TODO: Make filename search dynamic.
 *
 * @param {Object} auth An authorized OAuth2 client.
 */
function getDoc(auth) {
  return new Promise(function(resolve, reject) {
    var drive = google.drive('v3')
    drive.files.list({
      auth: auth,
      pageSize: 1,
      q: "name='Basic Cover Letter'", //TODO: Make this dynamic.
      fields: 'files(id)'
    }, function(err, response) {
      if (err) {
        reject(Error("Unable to find cover letter in Drive."))
      }
      else {
        var files = response.files
        if (files.length == 0) {
          reject(Error("Unable to find cover letter in Drive."))
        } else {
          resolve({auth: auth, fileID: files[0].id})
        }
      }
    })
  })
}

/**
 * Create a copy of the 'Generic Cover Letter' and return this
 * new document's ID.
 *
 * @param {Object} auth An authorized OAuth2 client.
 * @param String fileID The file ID of the newly created cover letter.
 */
function createDoc({auth, fileID}) {
  return new Promise(function(resolve, reject) {
    var drive = google.drive('v3')
    drive.files.copy({
      auth: auth,
      fileId: fileID
    }, function(err, response) {
      if (err) {
        reject(Error("Unable to create a cover letter copy."))
      }
      else{
        resolve({auth: auth, fileID: response.id})
      }
    })
  })
}

/**
 * Call an Apps Script function to replace company name and position in cover letter.
 *
 * @param {Object} auth An authorized OAuth2 client.
 * @param String fileID The file ID of the newly created cover letter.
 */
function callAppsScript({auth, fileID}) {
  return new Promise(function(resolve, reject) {
    var scriptId = process.env.GOOGLE_SCRIPT_ID //TODO: Make this dynamic.
    var script = google.script('v1')
    script.scripts.run({
      auth: auth,
      resource: {
        function: 'findAndReplace',
        parameters: [
          documentID=fileID,
          companyName=COMPANY,
          companyPosition=POSITION
        ],
        devMode: true //TODO: Set to false after deploying newest version of App Script
      },
      scriptId: scriptId
    }, function(err, resp) {
      if (err) {
        console.log(err)
        reject(Error("The app script encountered a problem before running."))
      }
      if (resp.error) {
        // The API executed, but the script returned an error.

        // Extract the first (and only) set of error details. The values of this
        // object are the script's 'errorMessage' and 'errorType', and an array
        // of stack trace elements.
        var error = resp.error.details[0]
        console.log('Script error message: ' + error.errorMessage)
        
        if (error.scriptStackTraceElements) {
          console.log('Script error stacktrace:')
          // There may not be a stacktrace if the script didn't start executing.
          for (var i = 0; i < error.scriptStackTraceElements.length; i++) {
            var trace = error.scriptStackTraceElements[i]
            console.log('\t%s: %s', trace.function, trace.lineNumber)
          }
        }
        reject(Error("The app script returned an error."))
      } else {
        resolve({auth: auth, fileID: fileID})
      }
    })
  })
}

/**
 * Download the modified cover letter to current directory.
 *
 * @param {Object} auth An authorized OAuth2 client.
 * @param String fileID The file ID of the newly created cover letter.
 */
function downloadLetter({auth, fileID}) {
  return new Promise(function(resolve, reject) {
    var dest = fs.createWriteStream('CoverLetter-' + 
      COMPANY + '-' + POSITION + '.pdf') 
    var drive = google.drive('v3')
    drive.files.export({
      auth: auth,
      fileId: fileID,
      mimeType: 'application/pdf'
    })
    .on('end', function() {
      resolve("Cover letter downloaded successfully.")
    })
    .on('error', function(err) {
      reject(Error("Unable to download new cover letter."))
    })
    .pipe(dest)
  })
}