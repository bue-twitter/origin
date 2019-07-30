'use strict'

const express = require('express')
const router = express.Router()
const request = require('superagent')
const querystring = require('querystring')

const Attestation = require('../models/index').Attestation
const AttestationTypes = Attestation.AttestationTypes
const { generateAttestation } = require('../utils/attestation')
const { kakaoVerify } = require('../utils/validation')
const logger = require('../logger')

const { getAbsoluteUrl } = require('../utils')
const constants = require('../constants')

/* Generate a URL for the user to be redirected to that prompts for a KaKao
 * login and then redirects to the URL specified in the redirect_uri parameter.
 *
 */
router.get('/auth-url', (req, res) => {
  const redirect = req.query.redirect || null

  const params = {
    client_id: process.env.KAKAO_CLIENT_ID,
    response_type: 'code',
    redirect_uri: getAbsoluteUrl('/redirects/kakao/')
  }

  if (redirect) {
    params.state = req.sessionID
    req.session.redirect = redirect
  }

  const url = `${
    constants.KAKAO_BASE_AUTH_URL
  }/authorize?${querystring.stringify(params)}`
  res.send({ url: url })
})

/* Exchange code from login dialog for an access token and generate attestation
 * from the user data.
 */
router.post('/verify', kakaoVerify, async (req, res) => {
  const params = {
    client_id: process.env.KAKAO_CLIENT_ID,
    client_secret: process.env.KAKAO_CLIENT_SECRET,
    redirect_uri: getAbsoluteUrl('/redirects/kakao/'),
    code: req.body.code,
    grant_type: 'authorization_code'
  }

  if (req.body.sid) {
    try {
      const session = await req.sessionStore.get(req.body.sid)
      params.code = session.code
      params.state = req.body.sid
    } catch (e) {
      return res.status(400).send({
        errors: ['Invalid session']
      })
    }
  }

  // Exchange code for an access token
  let accessToken
  try {
    const response = await request
      .post(constants.KAKAO_BASE_AUTH_URL + '/token')
      .query(params)
    accessToken = response.body.access_token
  } catch (error) {
    logger.error(error)
    return res.status(500).send({
      errors: ['Could not get access token']
    })
  }

  // Verify the token and determine the user account that it was generated for,
  // use that data to generate the attetation
  let userDataResponse
  try {
    userDataResponse = await request.get(constants.KAKAO_PROFILE_URL).set({
      Authorization: `Bearer ${accessToken}`
    })
  } catch (error) {
    logger.error(error)
    return res.status(500).send({
      errors: ['Error validating access token']
    })
  }

  const attestationBody = {
    verificationMethod: {
      oAuth: true
    },
    site: {
      siteName: 'kakao.com',
      userId: {
        raw: String(userDataResponse.body.id)
      }
    }
  }

  try {
    const attestation = await generateAttestation(
      AttestationTypes.KAKAO,
      attestationBody,
      {
        uniqueId: userDataResponse.body.id,
        profileData: userDataResponse
      },
      req.body.identity,
      req.ip
    )

    return res.send(attestation)
  } catch (error) {
    logger.error(error)
    return res.status(500).send({
      errors: ['Could not create attestation.']
    })
  }
})

module.exports = router
