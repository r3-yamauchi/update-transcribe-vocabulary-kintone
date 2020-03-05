const AWS = require('aws-sdk');
const s3 = new AWS.S3({ apiVersion: '2006-03-01', region: process.env.AWS_REGION });
const sns = new AWS.SNS({ apiVersion: '2010-03-31', region: process.env.AWS_REGION });
const transcribeservice = new AWS.TranscribeService({ apiVersion: '2017-10-26', region: process.env.AWS_REGION });

const log4js = require('log4js');
log4js.configure({
  appenders: { console: { type: 'console', layout: { type: 'pattern', pattern: '[%p] %m' } } },
  categories: { default: { appenders: ['console'], level: 'error' } }
});
const logger = log4js.getLogger('console');
logger.level = process.env.LOG_LEVEL || 'info';

const { KintoneRestAPIClient } = require('@kintone/rest-api-client');
const client = new KintoneRestAPIClient({
  baseUrl: `https://${process.env.KINTONE_HOSTNAME}`,
  auth: { apiToken: process.env.KINTONE_APITOKEN }
});
const TARGET_APPID = process.env.TARGET_APPID;
const LANGUAGE_CODE = process.env.LANGUAGE_CODE;
const VOCABULARY_NAME = process.env.VOCABULARY_NAME;
const VOCABULARY_FILE_BUCKET_NAME = process.env.VOCABULARY_FILE_BUCKET_NAME;
const VOCABULARY_FILE_KEY = process.env.VOCABULARY_FILE_KEY;
const VOCABULARY_FILE_URI = `s3://${VOCABULARY_FILE_BUCKET_NAME}/${VOCABULARY_FILE_KEY}`;

const getResponse = (statusCode, body) => {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body
  };
};

exports.handler = async (event) => {
  logger.info('Proc Start');
  logger.debug(event);

  const lines = [];
  lines.push('Phrase\tIPA\tSoundsLike\tDisplayAs');

  // kintone アプリからカスタム語彙に含めるレコードを取得する
  const query_result = await client.record.getAllRecords({
    app: TARGET_APPID,
    fields: ['Phrase', 'DisplayAs'],
    condition: 'isValid in ("有効")'
  });
  logger.debug(query_result);

  query_result.forEach((record) => {
    const phrase = record['Phrase'] ? record['Phrase']['value'] : '';
    const displayAs = record['DisplayAs'] ? record['DisplayAs']['value'] : '';
    if (phrase && displayAs) {
      // Phrase と DisplayAs が指定されていなければ登録できない
      lines.push(`${phrase}\t\t\t${displayAs}`);
    }
  });
  logger.debug(JSON.stringify(lines));

  if (lines.length == 1) {
    // 登録する語彙がない
    return getResponse(404, JSON.stringify(query_result));
  }

  // S3 へアップロード
  const res = await s3.putObject({
    Bucket: VOCABULARY_FILE_BUCKET_NAME,
    Key: VOCABULARY_FILE_KEY,
    Body: lines.join('\n')
  }).promise();
  logger.debug(res);

  // カスタム語彙の更新
  const result = await transcribeservice.updateVocabulary({
    LanguageCode: LANGUAGE_CODE,
    VocabularyName: VOCABULARY_NAME,
    VocabularyFileUri: VOCABULARY_FILE_URI
  }).promise();
  logger.info(result);

  return getResponse(200, JSON.stringify(result));
};

exports.check_handler = async (event) => {
  logger.info('Check Start');
  logger.debug(event);

  const result = await transcribeservice.getVocabulary({
    VocabularyName: VOCABULARY_NAME
  }).promise();
  logger.info(result);

  if (result.VocabularyState !== 'READY') {
    await sns.publish({
      Message: JSON.stringify(result),
      Subject: 'Vocabulary is not ready.',
      TopicArn: process.env.SNS_ERROR_TOPIC_ARN
    }).promise();
    return getResponse(400, JSON.stringify(result));
  }

  return getResponse(200, JSON.stringify(result));
};
