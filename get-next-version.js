const packageJson = require('./package.json')
const conventionalRecommendedBump = require('conventional-recommended-bump')
const semver = require('semver')

const getNextVersion = currentVersion => {
  return new Promise((resolve, reject) => {
    conventionalRecommendedBump(
      {
        preset: 'angular',
      },
      (err, release) => {
        if (err) {
          reject(err)
          return
        }

        const nextVersion =
          semver.valid(release.releaseType) ||
          semver.inc(currentVersion, release.releaseType)

        resolve(nextVersion)
      }
    )
  })
}

getNextVersion(packageJson.version)
  .then(version => console.log(version))
  .catch(error => console.log(error))