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


// Helpers
// -------

function printUsage () {
    console.log(
`
Usage:

node runner.js --user=[fotolog_username]
`
    );
}

function printStep (status) {
    console.log(chalk.green(status));
}

function printStatus (status) {
    console.log('  ' + chalk.gray(status));
}

/**
 * Returns the numeric part of the URL.
 */
function getUrlNumericPart (url) {
    return parseInt(url.match(/\/(\d+)(?:\/|$)/)[1]);
}

/**
 * Synchronously iterates through all links and incrementally get results,
 * using async callbacks. Returns a Promise which is resulted when all links are
 * iterated.
 */
function iterateLinks (links, index, memory, callback) {
    return new Promise((resolve, reject) => {
        callback(links[index]).then((results) => {
            memory = memory.concat(results);

            if (index === links.length - 1) {
                resolve(memory);
            } else {
                iterateLinks(links, index + 1, memory, callback).then((results) => {
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
var postsPerMosaicPage = 30;
var postsLinks = [];
var posts = [];
var mosaicLink = `http://www.fotolog.com/${username}/mosaic`;
var dirName = `fotolog_${username}_data`;

function saveUserFotolog () {
    console.log(chalk.yellow(`Getting data from ${username}...`));

    request(mosaicLink, (error, response, body) => {
        var $ = cheerio.load(body);

        getAllPosts(getMosaicPagesLinks($, username))
            .then(getPostsData)
            .then(savePostsDataToDisk);
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

    printStep('Getting all mosaic pagination links...');

    // There's only one page
    if ($pagination.find('a').length === 1) {
        printStatus('- User has only one page of photos');

        maxOffset = 0;
    // The last page is within the first 6 pages, so the last is the link before
    } else if (lastLink === `${mosaicLink}/30`) {
        printStatus('- User has up to 6 pages of photos');

        maxOffset = getUrlNumericPart($pagination.find('a:nth-last-of-type(2)').attr('href'));
    // User has a lot of pages, so the last page is the last link
    } else {
        printStatus('- User has more than 6 pages of photos');

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

    printStatus(`- Built links for ${pagesQty} pages`);

    return links;
}


// Traversing - Gettings Posts
// ---------------------------

/**
 * Gets all posts from all mosaic page links. Returns a Promise which is
 * resolved when all posts are retrived.
 */
function getAllPosts (mosaicLinks) {
    printStep('Getting all posts links...');

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

            printStatus(`- Retrieved ${postLinks.length} post links from ${link}`);

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
    printStep(`Retrieving data from ${postsLinks.length} posts...`);

    return new Promise((resolve, reject) => {
        iterateLinks(postsLinks, 0, [], getPostData).then(resolve);
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

            data.id = getUrlNumericPart(link);
            data.imageUrl = $('#flog_img_holder').find('img').attr('src');
            data.description = $('#description_photo').text();

            printStatus(`- Retrieved post data from ${link}`);

            resolve(data);
        });
    });
}


// Saving data to the disk
// -----------------------

function savePostsDataToDisk (postsData) {
    printStep(`Saving all data from ${username}`);

    rimraf.sync(dirName);

    printStatus(`- Removed any previous data`);

    fs.mkdirSync(dirName);

    printStatus(`- Created output directory`);

    return new Promise((resolve, reject) => {
        iterateLinks(postsData, 0, [], savePostDataToDisk).then(resolve);
    });
}

function savePostDataToDisk (postData) {
    return new Promise((resolve, reject) => {
        fs.writeFileSync(`${dirName}/${postData.id}.txt`, postData.description);
        request(postData.imageUrl).pipe(fs.createWriteStream(`${dirName}/${postData.id}.jpg`)).on('close', resolve);

        printStatus(`- Saved photo and post data from post ${postData.id}`);
    });
}

saveUserFotolog();