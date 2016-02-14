'use strict';

// Dependencies
// ------------

var fs = require('fs');
var rimraf = require('rimraf');
var path = require('path');
var request = require("request");
var argv = require('minimist')(process.argv.slice(2));
var chalk = require('chalk');
var cheerio = require('cheerio');
var he = require('he');
var moment = require('moment');


// Helpers
// -------

function printUsage () {
    console.log(
`
Usage:

node runner.js --user=[fotolog_username]

Options:

  --skipcomments

    Don't fetch post comments
`
    );
}

function printLogLevel (str, level) {
    var indentation = Array(level + 1).join('  ');
    console.log(chalk[levelColors[level]](`${indentation}${str}`));
}


/**
 * Returns the numeric part of the URL.
 */
function getUrlNumericPart (url) {
    return parseInt(url.match(/\/(\d+)(?:\/|$)/)[1]);
}

/**
 * Synchronously iterates through all links and incrementally get results,
 * using async callbacks. Returns a Promise which is resolved when all links are
 * iterated.
 */
function iterateLinks (links, index, memory, callback, message) {
    if (message) {
        printLogLevel(`- ${message} - ${index + 1}/${links.length}`, 1);
    }

    return new Promise((resolve, reject) => {
        callback(links[index]).then((results) => {
            memory = memory.concat(results);

            if (index === links.length - 1) {
                resolve(memory);
            } else {
                iterateLinks(links, index + 1, memory, callback, message).then((results) => {
                    resolve(results);
                });
            }
        });
    });
}


// API
// ---

if (argv.help || argv.h) {
    printUsage();
    process.exit(0);
}

if (!argv.user) {
    console.error(chalk.red('You must specify a Fotolog username.\n'));
    printUsage();
    process.exit(1);
}


// Program main execution
// ----------------------

var username = argv.user;
var shouldSkipComments = argv.skipcomments;
var postsPerMosaicPage = 30;
var postsLinks = [];
var posts = [];
var mosaicLink = `http://www.fotolog.com/${username}/mosaic`;
var dirName = `fotolog_${username}_data`;
var localisedDateFormats = {
    it: 'DD MMMM YYYY',
    pt: 'DD MMMM YYYY',
    fr: 'DD MMMM YYYY',
    es: 'DD MMMM YYYY',
    en: 'MMMM DD YYYY'
};
var levelColors = ['green', 'white', 'gray'];

function saveUserFotolog () {
    console.log(chalk.yellow(`Getting data from ${username}...`));

    request(mosaicLink, (error, response, body) => {
        var $ = cheerio.load(body);

        getAllPosts(getMosaicPagesLinks($, username))
            .then(getPostsData)
            .then(savePostsDataToDisk)
            .then((postsData) => {
                printLogLevel(`Done! Saved ${postsData.length} post(s) to the ${dirName} folder.`, 0);
            });
    });
}


// Traversing - Gettings Mosaic Pages
// ----------------------------------

/**
 * Look up for the mosaic pagination links on the DOM and returns an array with
 * the link for each page.
 */
function getMosaicPagesLinks ($, username) {
    var $pagination = $('#pagination');
    var lastLink = $pagination.find('a:last-of-type').attr('href');
    var maxOffset;

    printLogLevel('Getting all mosaic pagination links...', 0);

    // There's no pagination
    if ($pagination.length === 0 || $pagination.find('a').length === 0) {
        printLogLevel('- User has only one page of photos, no pagination', 1);

        maxOffset = 0;
    // There's only one page
    } else if ($pagination.find('a').length === 1) {
        printLogLevel('- User has only one page of photos', 1);

        maxOffset = 0;
    // The last page is within the first 6 pages, so the last is the link before
    } else if (lastLink === `${mosaicLink}/30`) {
        printLogLevel('- User has up to 6 pages of photos', 1);

        maxOffset = getUrlNumericPart($pagination.find('a:nth-last-of-type(2)').attr('href'));
    // User has a lot of pages, so the last page is the last link
    } else {
        printLogLevel('- User has more than 6 pages of photos', 1);

        maxOffset = getUrlNumericPart(lastLink);
    }

    return buildMosaicPagesLinks(maxOffset);
}

/**
 * Builds an array of all mosaic links, based on the pagination's last offset.
 */
function buildMosaicPagesLinks (maxOffset) {
    var pagesQty = (maxOffset / postsPerMosaicPage) + 1;
    var links = [];

    for (var i = 0; i < pagesQty; i++) {
        let offset = i * postsPerMosaicPage;

        if (offset === 0) {
            links.push(mosaicLink);
        } else {
            links.push(`${mosaicLink}/${offset}`);
        }
    }

    printLogLevel(`- Built links for ${pagesQty} pages`, 1);

    return links;
}


// Traversing - Gettings Posts
// ---------------------------

/**
 * Gets all posts from all mosaic page links. Returns a Promise which is
 * resolved when all posts are retrived.
 */
function getAllPosts (mosaicLinks) {
    printLogLevel('Getting all posts links...', 0);

    return new Promise((resolve, reject) => {
        iterateLinks(mosaicLinks, 0, [], getPostsFromMosaicLink).then(resolve);
    });
}

/**
 * Gets all posts from a single mosaic page link. Returns a Promise which is
 * resolved when all posts are retrived.
 */
function getPostsFromMosaicLink (link) {
    return new Promise((resolve, reject) => {
        request(link, (error, response, body) => {
            var $ = cheerio.load(body);
            var postLinks = [];

            $('#list_photos_mosaic').find('a').each((index, element) => {
                postLinks.push($(element).attr('href'));
            });

            printLogLevel(`- Retrieved ${postLinks.length} post links from ${link}`, 1);

            resolve(postLinks);
        });
    });
}


// Traversing - Gettings photos and data
// -------------------------------------

/**
 * Gets photos and data from all posts. Returns a Promise which is resolved
 * when all data is retrieved.
 */
function getPostsData (postsLinks) {
    printLogLevel(`Retrieving data from ${postsLinks.length} posts...`, 0);

    return new Promise((resolve, reject) => {
        iterateLinks(postsLinks, 0, [], getPostData, 'Retrieving post data').then(resolve);
    });
}

/**
 * Gets a post's main photo and additional data. Returns a Promise which is
 * resolved when the post's data is retrieved.
 */
function getPostData (link) {
    return new Promise((resolve, reject) => {
        request(link, (error, response, body) => {
            var $ = cheerio.load(body);
            var data = {};
            var lang = $('html').attr('lang') || 'en';
            var dateRegex = /[^\s]+\s+[^\s]+\s+[^\s]+\s+\d+\s+(?:Views|Vistas|Vues|Visualizações)/;

            data.id = getUrlNumericPart(link);
            data.imageUrl = $('#flog_img_holder').find('img').attr('src');
            data.description = $('#description_photo').text();
            // Fotolog doesn't give us an easy way to get the date so... yeah.
            moment.locale(lang);
            data.date = moment(data.description.match(dateRegex)[0].split(/\s+/).slice(0, 3).join(' '), localisedDateFormats[lang]);

            if (shouldSkipComments) {
                printLogLevel(`Retrieved post data from ${link}`, 2);

                resolve(data);
                return;
            }

            getPostComments($, data.id).then((comments) => {
                data.comments = comments;

                printLogLevel(`Retrieved post data from ${link}`, 2);

                resolve(data);
            });
        });
    });
}

/**
 * Gets a post's comments. The first 44 are retrieved straight from the DOM.
 * The others are retrieved through POST requests on the comments endpoint.
 * Returns a Promise which is resolved when all comments are retrived.
 */
function getPostComments ($, id) {
    var comments = [];

    $('.flog_img_comments').each((index, element) => {
        // The first element is the login form link :S
        if (index === 0) { return; }

        comments.push({
            avatarImgUrl: $(element).find('.comment_avatar').attr('src'),
            username: $(element).find('p b').text(),
            // this gets the first dd/mm/yyyy occurrence
            date: $(element).children('p').text().match(/\d{2}\/\d{2}\/\d{4}/)[0],
            // since the whole comment block is a single paragraph, we get
            // everything after the first two breaklines
            message: $(element).children('p').html().split('<br><br>').slice(1).join('<br><br>')
        });
    });

    return new Promise((resolve, reject) => {
        iterateCommentRequests(id, 45, comments).then(resolve);
    });
}

/**
 * Synchronously request comments and incrementally get results,
 * using async callbacks. Returns a Promise which is resolved when the request
 * returns 0 results.
 */
function iterateCommentRequests (id, offset, memory) {
    return new Promise((resolve, reject) => {
        fetchComments(id, offset).then((results) => {
            memory = memory.concat(results);

            if (results.length === 0) {
                resolve(memory);
            } else {
                iterateCommentRequests(id, offset + 45, memory).then((results) => {
                    resolve(results);
                });
            }
        });
    });
}

/**
 * Fetches comments from a given post id and offset. Returns a Promise which
 * is resolved when the comments are fetched.
 */
function fetchComments (id, offset) {
    return new Promise((resolve, reject) => {
        request.post('http://fotolog.com/ajax/load_more_comments', { form: {
            user_name: username,
            identifier: id,
            offset: offset
        } }, (error, response, body) => {
            var response = JSON.parse(body);
            var comments = response.comments;

            if (!response.success || !comments || (!Array.isArray(comments) && Object.keys(comments) === 0)) {
                resolve([]);
                return;
            }

            if (!Array.isArray(comments)) {
                comments = Object.keys(comments).map((index) => {
                    return comments[index];
                });
            }

            resolve(comments.map((comment) => {
                return {
                    avatarImgUrl : comment.avatar,
                    username: comment.poster_user_name,
                    date: comment.posted.split(/\s+/)[1],
                    message: comment.message
                }
            }));
        });
    });
}


// Saving data to the disk
// -----------------------

function savePostsDataToDisk (postsData) {
    printLogLevel(`Saving all data from ${username}`, 0);

    rimraf.sync(dirName);

    printLogLevel(`- Removed any previous data`, 1);

    fs.mkdirSync(dirName);

    printLogLevel(`- Created output directory`, 1);

    return new Promise((resolve, reject) => {
        iterateLinks(postsData, 0, [], savePostDataToDisk, 'Saving post data').then(resolve);
    });
}

function savePostDataToDisk (postData) {
    return new Promise((resolve, reject) => {
        var postYear = postData.date.format('YYYY');
        var postMonth = postData.date.format('MM');
        var postDay = postData.date.format('DD');
        var filePath = `${dirName}/${postYear}/${postMonth}`;
        var filePrefix = `${postYear}${postMonth}${postDay}_`;

        try {
            fs.mkdirSync(`${dirName}/${postYear}`);
        } catch(e) {}

        try {
            fs.mkdirSync(`${dirName}/${postYear}/${postMonth}`);
        } catch(e) {}

        fs.writeFileSync(`${filePath}/${filePrefix}${postData.id}.txt`,
            he.decode(postData.description) +
            (shouldSkipComments ?
                '' :
                '\n\n' +
                '========================================\n' +
                '                COMMENTS\n' +
                '========================================\n\n' +
                he.decode(postData.comments.map((comment) => {
                    return `${comment.username} on ${comment.date}:\n\n${comment.message}`;
                }).join('\n\n-------------------\n\n')))
        );

        request(postData.imageUrl).pipe(fs.createWriteStream(`${filePath}/${filePrefix}${postData.id}.jpg`)).on('close', resolve);

        printLogLevel(`Saved photo and post data from post ${postData.id}`, 2);
        printLogLevel(`Post date: ${postDay}/${postMonth}/${postYear}`, 2);
        printLogLevel(`Comments: ${postData.comments.length}`, 2);
    });
}

saveUserFotolog();