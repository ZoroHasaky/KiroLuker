import { app } from 'electron'
import { join } from 'path'
import { migrateLegacyUserData } from './userDataMigration'

const APP_NAME = 'KiroLuker'

app.setName(APP_NAME)
const userDataDir = join(app.getPath('appData'), APP_NAME)
app.setPath('userData', userDataDir)
migrateLegacyUserData(app.getPath('appData'), userDataDir)

void import('./index')
