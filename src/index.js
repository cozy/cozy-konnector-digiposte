process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://f6f64db44c394bb3856d0198732634bf@sentry.cozycloud.cc/95'

const {
  BaseKonnector,
  log,
  saveFiles,
  cozyClient,
  requestFactory,
  errors,
  signin
} = require('cozy-konnector-libs')
const { getFileName } = require('./utils')
const fulltimeout = Date.now() + 4 * 60 * 1000
let request = requestFactory()
const j = request.jar()
request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: j
})

let xsrfToken = null
let accessToken = null
let healthToken = null

module.exports = new BaseKonnector(fetch)

async function fetch(requiredFields) {
  // Login and fetch multiples tokens
  await login(requiredFields)
  await fetchTokens(requiredFields.password)
  request = request.defaults({
    auth: {
      bearer: accessToken
    }
  })
  // Now get the list of folders
  log('info', 'Getting the list of folders')
  const folders = await request(
    'https://secure.digiposte.fr/api/v3/folders/safe'
  )
  return fetchFolder(folders, requiredFields.folderPath, fulltimeout)
}

function login({ email, password }) {
  return signin({
    url: `https://secure.digiposte.fr/identification-plus`,
    requestInstance: request,
    formSelector: 'form',
    formData: { _username: email, _password: password },
    validate: (statusCode, $, fullResponse) => {
      if (
        fullResponse.request.uri.href ===
        'https://compte.laposte.fr/fo/v1/login'
      ) {
        return false
      } else if (
        fullResponse.request.uri.href === 'https://secure.digiposte.fr/'
      ) {
        return true
      } else if (
        fullResponse.request.uri.href ===
        'https://secure.digiposte.fr/question-secret'
      ) {
        throw new Error(errors.USER_ACTION_NEEDED_CGU_FORM)
      } else {
        log('error', fullResponse.request.uri.href)
        throw new Error(errors.VENDOR_DOWN)
      }
    }
  })
}

// Read the XSRF-TOKEN in the cookie jar and set it globably
async function extractXsrfToken() {
  log('info', 'Getting the XSRF token for cookie jar')
  let xsrfcookie = j
    .getCookies('https://secure.digiposte.fr/')
    .find(cookie => cookie.key === 'XSRF-TOKEN')

  if (!xsrfcookie) {
    log('error', 'Problem fetching the xsrf-token')
    throw new Error(errors.VENDOR_DOWN)
  }
  xsrfToken = xsrfcookie.value
  log('debug', 'XSRF token is set to ' + xsrfToken)
}

async function fetchTokens(password) {
  // Extract a first Xsrf
  extractXsrfToken()

  // Get the access token
  log('info', 'Getting the app access token')
  request = requestFactory({
    cheerio: false,
    json: true,
    jar: j
  })
  request = request.defaults({
    headers: {
      'X-XSRF-TOKEN': xsrfToken
    }
  })
  let body = await request('https://secure.digiposte.fr/rest/security/tokens')
  if (body && body.access_token) {
    accessToken = body.access_token
  } else {
    log('error', 'Problem fetching the access token')
    throw new Error(errors.VENDOR_DOWN)
  }

  // Requesting healthToken with password
  log('info', `Getting the health-token`)
  await request(
    {
      url: 'https://secure.digiposte.fr/rest/security/health-token',
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*'
      },
      json: {
        password: password // need password again here
      }
    },
    (error, response, body) => {
      healthToken = body.access_token
    }
  )

  // Extract a second Xsrf as it changed
  extractXsrfToken()
  // eslint-disable-next-line require-atomic-updates
  request = request.defaults({
    headers: {
      'X-XSRF-TOKEN': xsrfToken
    }
  })
}

// create a folder if it does not already exist
function mkdirp(path, folderName) {
  folderName = sanitizeFolderName(folderName)
  return cozyClient.files.statByPath(`${path}/${folderName}`).catch(err => {
    log('info', err.message, `${path} folder does not exist yet, creating it`)
    return cozyClient.files
      .statByPath(`${path}`)
      .then(parentFolder =>
        cozyClient.files.createDirectory({
          name: folderName,
          dirID: parentFolder._id
        })
      )
      .catch(err => {
        if (err.status !== 409) {
          throw err
        }
      })
  })
}

function sanitizeFolderName(foldername) {
  return foldername.replace(/^\.+$/, '').replace(/[/?<>\\:*|":]/g, '')
}

async function fetchFolder(body, rootPath, timeout) {
  // Then, for each folder, get the logo, list of files : name, url, amount, date
  body.folders = body.folders || []
  log('info', 'Getting the list of documents for each folder')
  log('info', `TIMEOUT in ${Math.floor((timeout - Date.now()) / 1000)}s`)

  // If this is the root folder, also fetch it's documents
  if (!body.name) body.folders.unshift({ id: '', name: '' })

  let folders = []
  for (let folder of body.folders) {
    let result = {
      id: folder.id,
      name: folder.name,
      folders: folder.folders
    }
    log('info', (folder.name || 'root_dir') + '...')
    folder = await request.post(
      'https://secure.digiposte.fr/api/v3/documents/search',
      {
        headers: {
          Authorization: `Bearer ${healthToken}` //* Need the health-token here
        },
        qs: {
          direction: 'DESCENDING',
          max_results: 100,
          sort: 'CREATION_DATE'
        },
        body: {
          folder_id: result.id,
          locations: ['SAFE', 'INBOX']
        }
      }
    )
    result.docs = folder.documents.map(doc => {
      let tmpDoc = {
        docid: doc.id,
        type: doc.category,
        fileurl: `https://secure.digiposte.fr/rest/content/document?_xsrf_token=${xsrfToken}`,
        filename: getFileName(doc),
        vendor: doc.sender_name,
        requestOptions: {
          method: 'POST',
          jar: j,
          form: {
            'document_ids[]': doc.id
          }
        }
      }

      // Orange payslip specific
      if (doc.category === 'Bulletin de paie' && doc.author_name === 'Orange') {
        const creationDateObj = new Date(doc.creation_date)
        const nextMonthObj = new Date(
          Date.UTC(
            creationDateObj.getFullYear(),
            creationDateObj.getMonth() + 1,
            1
          )
        ) // First day of next month
        const lastDayObj = new Date(
          Date.UTC(nextMonthObj.getFullYear(), nextMonthObj.getMonth())
        )
        lastDayObj.setDate(0) // Set day before the first day of next month
        // First day of the month
        const firstDayStg = new Date(
          Date.UTC(creationDateObj.getFullYear(), creationDateObj.getMonth(), 1)
        ).toISOString()

        tmpDoc.fileAttributes = {
          metadata: {
            classification: 'payslip',
            datetime: firstDayStg,
            datetimeLabel: 'startDate',
            contentAuthor: 'orange',
            startDate: firstDayStg,
            endDate: lastDayObj.toISOString(),
            issueDate: doc.creation_date
          }
        }
      }
      return tmpDoc
    })
    if (result && result.docs) {
      log('info', '' + result.docs.length + ' document(s)')
    }
    folders.push(result)
  }

  // sort the folders by the number of documents
  folders.sort((a, b) => {
    return a.docs.length > b.docs.length ? 1 : -1
  })

  let index = 0
  for (let folder of folders) {
    const now = Date.now()
    const remainingTime = timeout - now
    const timeForThisFolder = remainingTime / (folders.length - index)
    index++
    log('info', 'Getting vendor ' + folder.name)
    log('info', `Remaining time : ${Math.floor(remainingTime / 1000)}s`)
    log(
      'info',
      `Time for this folder : ${Math.floor(timeForThisFolder / 1000)}s`
    )
    await mkdirp(rootPath, folder.name)
    if (folder.docs) {
      await saveFiles(
        folder.docs,
        `${rootPath}/${sanitizeFolderName(folder.name)}`,
        {
          timeout: now + timeForThisFolder
        }
      )
    }

    if (folder.name !== '') {
      await fetchFolder(
        folder,
        `${rootPath}/${sanitizeFolderName(folder.name)}`,
        now + timeForThisFolder
      )
    }
  }
}
