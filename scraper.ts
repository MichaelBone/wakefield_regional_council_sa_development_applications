// Parses the development applications at the South Australian Wakefield Regional Council web site
// and places them in a database.
//
// Michael Bone
// 31st January 2019

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import didYouMean, * as didyoumean from "didyoumean2";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.wakefieldrc.sa.gov.au/page.aspx?u=768";
const CommentUrl = "mailto:admin@wrc.sa.gov.au";

declare const process: any;

// All valid street names, street suffixes, suburb names and hundred names.

let StreetNames = null;
let StreetSuffixes = null;
let SuburbNames = null;
let HundredNames = null;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [legal_description] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if the row does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            developmentApplication.legalDescription
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\", legal description \"${developmentApplication.legalDescription}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\", legal description \"${developmentApplication.legalDescription}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// A bounding rectangle.

interface Rectangle {
    x: number,
    y: number,
    width: number,
    height: number
}

// An element (consisting of text and a bounding rectangle) in a PDF document.

interface Element extends Rectangle {
    text: string
}

// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.  Take care to avoid extremely tall elements (because these may otherwise
// be considered as part of all rows and effectively force the return value of this function to
// the same value, regardless of the value of startElement).

function getRowTop(elements: Element[], startElement: Element) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y)  // check for overlap
            if (getVerticalOverlapPercentage(startElement, element) > 50)  // avoids extremely tall elements
                if (element.y < top)
                    top = element.y;
    return top;
}

// Constructs a rectangle based on the intersection of the two specified rectangles.

function intersect(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}

// Calculates the square of the Euclidean distance between two elements.

function calculateDistance(element1: Element, element2: Element) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5)  // arbitrary overlap factor of 20% (ie. ignore elements that overlap too much in the horizontal direction)
        return Number.MAX_VALUE;
    return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
}

// Determines whether there is vertical overlap between two elements.

function isVerticalOverlap(element1: Element, element2: Element) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}

// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).

function getVerticalOverlapPercentage(element1: Element, element2: Element) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
}

// Gets the element immediately to the right of the specified element (but ignores elements that
// appear after a large horizontal gap).

function getRightElement(elements: Element[], element: Element) {
    let closestElement: Element = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) &&  // ensure that there is at least some vertical overlap
            getVerticalOverlapPercentage(element, rightElement) > 50 &&  // avoid extremely tall elements (ensure at least 50% overlap)
            (rightElement.x > element.x + element.width) &&  // ensure the element actually is to the right
            (rightElement.x - (element.x + element.width) < 30) &&  // avoid elements that appear after a large gap (arbitrarily ensure less than a 30 pixel gap horizontally)
            calculateDistance(element, rightElement) < calculateDistance(element, closestElement))  // check if closer than any element encountered so far
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}

// Finds the element that most closely matches the specified text.

function findElement(elements: Element[], text: string, shouldSelectRightmostElement: boolean) {
    // Examine all the elements on the page that being with the same character as the requested
    // text.
    
    let condensedText = text.replace(/[\s,\-_]/g, "").toLowerCase();
    let firstCharacter = condensedText.charAt(0);

    let matches = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith(firstCharacter))) {
        // Extract up to 5 elements to the right of the element that has text starting with the
        // required character (and so may be the start of the requested text).  Join together the
        // elements to the right in an attempt to find the best match to the text.

        let rightElement = element;
        let rightElements: Element[] = [];

        do {
            rightElements.push(rightElement);

            let currentText = rightElements.map(element => element.text).join("").replace(/[\s,\-_]/g, "").toLowerCase();

            if (currentText.length > text.length + 2)  // stop once the text is too long
                break;
            if (currentText.length >= text.length - 2) {  // ignore until the text is close to long enough
                if (currentText === condensedText)
                    matches.push({ leftElement: rightElements[0], rightElement: rightElement, threshold: 0, text: currentText });
                else if (didYouMean(currentText, [ condensedText ], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true }) !== null)
                    matches.push({ leftElement: rightElements[0], rightElement: rightElement, threshold: 1, text: currentText });
                else if (didYouMean(currentText, [ condensedText ], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true }) !== null)
                    matches.push({ leftElement: rightElements[0], rightElement: rightElement, threshold: 2, text: currentText });
            }

            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 5);  // up to 5 elements
    }

    // Chose the best match (if any matches were found).  Note that trimming is performed here so
    // that text such as "  Plan" is matched in preference to text such as "plan)" (when looking
    // for elements that match "Plan").  For an example of this problem see "200/303/07" in
    // "https://www.walkerville.sa.gov.au/webdata/resources/files/DA%20Register%20-%202007.pdf".

    if (matches.length > 0) {
        let bestMatch = matches.reduce((previous, current) =>
            (previous === undefined ||
            current.threshold < previous.threshold ||
            (current.threshold === previous.threshold && Math.abs(current.text.trim().length - condensedText.length) < Math.abs(previous.text.trim().length - condensedText.length)) ? current : previous), undefined);
        return shouldSelectRightmostElement ? bestMatch.rightElement : bestMatch.leftElement;
    }

    return undefined;
}

// Finds the start element of each development application on the current PDF page (there are
// typically two development applications on a single page and each development application
// typically begins with the text "Application No").

function findStartElements(elements: Element[]) {
    // Examine all the elements on the page that being with "A" or "a".
    
    let startElements: Element[] = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith("a"))) {
        // Extract up to 5 elements to the right of the element that has text starting with the
        // letter "a" (and so may be the start of the "Application No" text).  Join together the
        // elements to the right in an attempt to find the best match to the text "Application No".

        let rightElement = element;
        let rightElements: Element[] = [];
        let matches = [];

        do {
            rightElements.push(rightElement);
        
            // Allow for common misspellings of the "no." text.

            let text = rightElements.map(element => element.text).join("").replace(/[\s,\-_]/g, "").replace(/n0/g, "no").replace(/n°/g, "no").replace(/"o/g, "no").replace(/"0/g, "no").replace(/"°/g, "no").replace(/“°/g, "no").toLowerCase();
            if (text.length >= 16)  // stop once the text is too long
                break;
            if (text.length >= 13) {  // ignore until the text is close to long enough
                if (text === "applicationno")
                    matches.push({ element: rightElement, threshold: 0, text: text });
                else if (didYouMean(text, [ "ApplicationNo" ], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true }) !== null)
                    matches.push({ element: rightElement, threshold: 1, text: text });
                else if (didYouMean(text, [ "ApplicationNo" ], { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true }) !== null)
                    matches.push({ element: rightElement, threshold: 2, text: text });
            }

            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 5);  // up to 5 elements

        // Chose the best match (if any matches were found).

        if (matches.length > 0) {
            let bestMatch = matches.reduce((previous, current) =>
                (previous === undefined ||
                current.threshold < previous.threshold ||
                (current.threshold === previous.threshold && Math.abs(current.text.trim().length - "ApplicationNo".length) < Math.abs(previous.text.trim().length - "ApplicationNo".length)) ? current : previous), undefined);
            startElements.push(bestMatch.element);
        }
    }

    // Ensure the start elements are sorted in the order that they appear on the page.

    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    startElements.sort(yComparer);
    return startElements;
}

// Gets the text to the right in a rectangle, where the rectangle is delineated by the positions
// in which the three specified strings of (case sensitive) text are found.

function getRightText(elements: Element[], topLeftText: string, rightText: string, bottomText: string) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.

    let topLeftElement = findElement(elements, topLeftText, true);
    let rightElement = (rightText === undefined) ? undefined : findElement(elements, rightText, false);
    let bottomElement = (bottomText === undefined) ? undefined : findElement(elements, bottomText, false);
    if (topLeftElement === undefined)
        return undefined;

    let x = topLeftElement.x + topLeftElement.width;
    let y = topLeftElement.y;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);

    let bounds: Rectangle = { x: x, y: y, width: width, height: height };

    // Gather together all elements that are at least 50% within the bounding rectangle.

    let intersectingElements: Element[] = []
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    if (intersectingElements.length === 0)
        return undefined;

    // Sort the elements by Y co-ordinate and then by X co-ordinate.

    let elementComparer = (a: Element, b: Element) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);

    // Join the elements into a single string.

    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}

// Gets the text to the left in a rectangle, where the rectangle is delineated by the positions
// in which the three specified strings of (case sensitive) text are found.

function getLeftText(elements: Element[], topRightText: string, leftText: string, bottomText: string) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.

    let topRightElement = findElement(elements, topRightText, true);
    let leftElement = (leftText === undefined) ? undefined : findElement(elements, leftText, false);
    let bottomElement = (bottomText === undefined) ? undefined : findElement(elements, bottomText, false);
    if (topRightElement === undefined || leftElement === undefined || bottomElement === undefined)
        return undefined;

    let x = leftElement.x + leftElement.width;
    let y = topRightElement.y;
    let width = topRightElement.x - x;
    let height = bottomElement.y - y;

    let bounds: Rectangle = { x: x, y: y, width: width, height: height };

    // Gather together all elements that are at least 50% within the bounding rectangle.

    let intersectingElements: Element[] = []
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    if (intersectingElements.length === 0)
        return undefined;

    // Sort the elements by Y co-ordinate and then by X co-ordinate.

    let elementComparer = (a: Element, b: Element) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);

    // Join the elements into a single string.

    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}

// Gets the text downwards in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.

function getDownText(elements: Element[], topText: string, rightText: string, bottomText: string) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.

    let topElement = findElement(elements, topText, true);
    let rightElement = (rightText === undefined) ? undefined : findElement(elements, rightText, false);
    let bottomElement = (bottomText === undefined) ? undefined: findElement(elements, bottomText, false);
    if (topElement === undefined)
        return undefined;

    let x = topElement.x;
    let y = topElement.y + topElement.height;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);

    let bounds: Rectangle = { x: x, y: y, width: width, height: height };

    // Gather together all elements that are at least 50% within the bounding rectangle.

    let intersectingElements: Element[] = []
    for (let element of elements) {
        let intersectingBounds = intersect(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    if (intersectingElements.length === 0)
        return undefined;

    // Sort the elements by Y co-ordinate and then by X co-ordinate.

    let elementComparer = (a: Element, b: Element) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);

    // Join the elements into a single string.

    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}

// Parses the details from the elements associated with a single development application.

function parseApplicationElements(elements: Element[], startElement: Element, informationUrl: string) {
    // Get the application number.

    let applicationNumber = getRightText(elements, "Application No", "Application Date", "Applicants Name");
    if (applicationNumber === undefined || applicationNumber === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    applicationNumber = applicationNumber.replace(/[Il,]/g, "/");
    console.log(`    Found \"${applicationNumber}\".`);

    // Get the received date.

    let receivedDateText = "";

    if (elements.some(element => element.text.trim() === "Application Received")) {
        receivedDateText = getRightText(elements, "Application Received", "Planning Approval", "Land Division Approval");
        if (receivedDateText === undefined)
            receivedDateText = getRightText(elements, "Application Date", "Planning Approval", "Application Received");
    } else if (elements.some(element => element.text.trim() === "Application received")) {
        receivedDateText = getRightText(elements, "Application received", "Planning Approval", "Land Division Approval");
        if (receivedDateText === undefined)
            receivedDateText = getRightText(elements, "Application Date", "Planning Approval", "Application received");
    } else if (elements.some(element => element.text.trim() === "Building Approval")) {
        receivedDateText = getLeftText(elements, "Building Approval", "Application Date", "Building  received");
        if (receivedDateText === undefined)
            receivedDateText = getRightText(elements, "Application Date", "Planning Approval", "Building Approval");
    }

    let receivedDate: moment.Moment = undefined;
    if (receivedDateText !== undefined)
        receivedDate = moment(receivedDateText.trim(), "D/MM/YYYY", true);

    // Get the house number, street and suburb of the address.

    let houseNumber = getRightText(elements, "Property House No", "Planning Conditions", "Lot");
    if (houseNumber === undefined || houseNumber === "0")
        houseNumber = "";

    let streetName = getRightText(elements, "Property street", "Planning Conditions", "Property suburb");
    if (streetName === undefined || streetName === "" || streetName === "0") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found or parsed (there is no street name).  Elements: ${elementSummary}`);
        return undefined;
    }

    let suburbName = getRightText(elements, "Property suburb", "Planning Conditions", "Title");
    if (suburbName === undefined || suburbName === "" || suburbName === "0") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found or parsed (there is no suburb name for street \"${streetName}\").  Elements: ${elementSummary}`);
        return undefined;
    }

    // Get the legal description.

    let legalElements = [];

    let lot = getRightText(elements, "Lot", "Planning Conditions", "Section");
    if (lot !== undefined)
        legalElements.push(`Lot ${lot}`);

    let section = getRightText(elements, "Section", "Planning Conditions", "Plan");
    if (section !== undefined)
        legalElements.push(`Section ${section}`);

    let plan = getRightText(elements, "Plan", "Planning Conditions", "Property Street");
    if (plan !== undefined)
        legalElements.push(`Plan ${plan}`);

    let title = getRightText(elements, "Title", "Planning Conditions", "Hundred");
    if (title !== undefined)
        legalElements.push(`Title ${title}`);

    let hundred = getRightText(elements, "Hundred", "Planning Conditions", "Development Description");
    if (hundred !== undefined)
        legalElements.push(`Hundred ${hundred}`);

    let legalDescription = legalElements.join(", ");

    // Two addresses are sometimes recorded in the same field.  This is done in a way which is
    // ambiguous (ie. it is not possible to reconstruct the original addresses perfectly).
    //
    // For example, the following address:
    //
    //     House Number: ü35
    //           Street: RAILWAYüSCHOOL TCE SOUTHüTERRA
    //           Suburb: PASKEVILLEüPASKEVILLE
    //
    // should be interpreted as the following two addresses:
    //
    //     RAILWAY TCE SOUTH, PASKEVILLE
    //     35 SCHOOL TERRA(CE), PASKEVILLE
    //
    // whereas the following address:
    //
    //     House Number: 79ü4
    //           Street: ROSSLYNüSWIFT WINGS ROADüROAD
    //           Suburb: WALLAROOüWALLAROO
    //
    // should be interpreted as the following two addresses:
    //
    //     79 ROSSLYN ROAD, WALLAROO
    //     4 SWIFT WINGS ROAD, WALLAROO
    //
    // And so notice that in the first case above the "TCE" text of the Street belonged to the
    // first address.  Whereas in the second case above the "WINGS" text of the Street belonged
    // to the second address (this was deduced by examining actual existing street names).

    let address = "";

    if (houseNumber.includes("ü")) {
        // Split the house number on the "ü" character.

        let houseNumberTokens = houseNumber.split("ü");

        // The street name may have the same number of "ü" characters as the house number in
        // which case it is assumed the "ü" character delimits multiple street names (this seems
        // to be a very rare case).  More often, however, the street name will have twice as many
        // "ü" characters as the house number.  In this case the street names appear each broken
        // in two and joined into groups.
        //
        // Unfortunately, the street name is truncated at 30 characters so some of the "ü"
        // characters may be missing.  And, also note, that unfortunately there is an ambiguity
        // in some cases as to whether a space is a delimiter or is just a space that happens to
        // occur within a street name or suffix (such as "Kybunga Top" in "Kybunga Top Road" or
        // "TERRACE SOUTH" in "RAILWAY TERRACE SOUTH").
        //
        // For example,
        //
        //     KENNETT STREETüKENNETT STREET   <-- two street names delimited by a "ü" character
        //     PHILLIPSüHARBISON ROADüROAD     <-- street names broken in two and joined into groups
        //     BarrüFrances StreetüTerrace     <-- street names broken in two and joined into groups
        //     GOYDERüGOYDERüMail HDüHDüRoad   <-- street names broken in two and joined into groups
        //     ORIENTALüWINDJAMMER COURTüCOUR  <-- truncated street suffix
        //     TAYLORüTAYLORüTAYLOR STREETüST  <-- missing "ü" character due to truncation
        //     EDGARüEASTüEAST STREETüTERRACE  <-- missing "ü" character due to truncation
        //     SOUTH WESTüSOUTH WEST TERRACEü  <-- missing "ü" character due to truncation
        //     ChristopherüChristopher Street  <-- missing "ü" character due to truncation
        //     PORT WAKEFIELDüPORT WAKEFIELD   <-- missing "ü" character due to truncation
        //     NORTH WESTüNORTH WESTüNORTH WE  <-- missing "ü" characters due to truncation
        //     RAILWAYüSCHOOL TCE SOUTHüTERRA  <-- ambiguous space delimiter
        //     BLYTHüWHITE WELL HDüROAD        <-- ambiguous space delimiter
        //     Kybunga TopüKybunga Top RoadüR  <-- ambiguous space delimiter
        //     SOUTHüSOUTH TERRACE EASTüTERRA  <-- ambiguous space delimiter

        // Artificially increase the street name tokens to twice the length (minus one) of the
        // house number tokens (this then simplifies the following processing).  The "minus one"
        // is because the middle token will be split in two later.

        let streetNameTokens = streetName.split("ü");
        while (streetNameTokens.length < 2 * houseNumberTokens.length - 1)
            streetNameTokens.push("");

        // Consider the following street name (however, realistically this would be truncated at
        // 30 characters; this is ignored for the sake of explaining the parsing),
        //
        //     Kybunga TopüSmithüRailway South RoadüTerrace EastüTerrace
        //
        // This street name would be split into the following tokens,
        //
        //     Token 0: Kybunga Top
        //     Token 1: Smith
        //     Token 2: Railway South Road  <-- the middle token contains a delimiting space (it is ambiguous as to which space is the correct delimiter)
        //     Token 3: Terrace East
        //     Token 4: Terrace
        //
        // And from these tokens, the following candidate sets of tokens would be constructed
        // (each broken into two groups).  Note that the middle token [Railway South Road] is
        // broken into two tokens in different ways depending on which space is chosen as the
        // delimiter for the groups: [Railway] and [South Road] or [Railway South] and [Road].
        //
        //     Candidate 1: [Kybunga Top] [Smith] [Railway]   [South Road] [Terrace East] [Terrace]
        //                 └───────────╴Group 1╶───────────┘ └──────────────╴Group 2╶──────────────┘
        //
        //     Candidate 2: [Kybunga Top] [Smith] [Railway South]   [Road] [Terrace East] [Terrace]
        //                 └──────────────╴Group 1╶──────────────┘ └───────────╴Group 2╶───────────┘

        let candidates = [];

        let middleTokenIndex = houseNumberTokens.length - 1;
        if (!streetNameTokens[middleTokenIndex].includes(" "))  // the space may be missing if the street name is truncated at 30 characters
            streetNameTokens[middleTokenIndex] += " ";  // artificially add a space to simplify the processing

        let ambiguousTokens = streetNameTokens[middleTokenIndex].split(" ");
        for (let index = 1; index < ambiguousTokens.length; index++) {
            let group1 = [ ...streetNameTokens.slice(0, middleTokenIndex), ambiguousTokens.slice(0, index).join(" ")];
            let group2 = [ ambiguousTokens.slice(index).join(" "), ...streetNameTokens.slice(middleTokenIndex + 1)];
            candidates.push({ group1: group1, group2: group2, streetNames: [] });
        }

        // Full street names (with suffixes) can now be constructed for each candidate (by joining
        // together corresponding tokens from each group of tokens).

        for (let candidate of candidates) {
            for (let index = 0; index < houseNumberTokens.length; index++) {
                // Expand street suffixes such as "Tce" to "TERRACE".

                let streetSuffix = candidate.group2[index].split(" ")
                    .map(token => (StreetSuffixes[token.toUpperCase()] === undefined) ? token : StreetSuffixes[token.toUpperCase()])
                    .join(" ");

                // Choose the best matching street name (from the known street names).

                let houseNumber = houseNumberTokens[index];
                let streetName = (candidate.group1[index] + " " + streetSuffix).trim().replace(/\s\s+/g, " ");

                let streetNameMatch = didYouMean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 0, trimSpaces: true });
                if (streetNameMatch !== null)
                    candidate.streetNames.push({ houseNumber: houseNumber, streetName: streetName, threshold: 0 });
                else {
                    streetNameMatch = didYouMean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true });
                    if (streetNameMatch !== null)
                        candidate.streetNames.push({ houseNumber: houseNumber, streetName: streetNameMatch, threshold: 1 });
                    else {
                        streetNameMatch = didYouMean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
                        if (streetNameMatch !== null)
                            candidate.streetNames.push({ houseNumber: houseNumber, streetName: streetNameMatch, threshold: 2 });
                        else
                            candidate.streetNames.push({ houseNumber: houseNumber, streetName: streetName, threshold: Number.MAX_VALUE });
                    }
                }
            }
        }

        // Where there are multiple candidates mark down the candidates that end in " HD" (and so
        // appear to represent a hundred name) but do not actually contain a valid hundred name.
        // For example, the valid address "292 Lake View Road" in "Candidate 1" is the better
        // choice in the following because the hundred name in "Candidate 0" is invalid.
        //
        //     BARUNGAüLake View HDüRoad
        //
        // Candidate 0: [BARUNGA] [Lake]   [View HD] [Road]
        //             └───╴Group 1╶────┘ └───╴Group 2╶────┘
        //     Resulting street names:
        //         BARUNGA View HD  <-- invalid hundred name
        //         Lake Road        <-- valid street name
        //
        // Candidate 1: [BARUNGA] [Lake View]   [HD] [Road]
        //             └──────╴Group 1╶──────┘ └─╴Group 2╶─┘
        //     Resulting street names:
        //         BARUNGA HD      <-- valid hundred name 
        //         Lake View Road  <-- valid street name


        
        // Choose an address that:
        //
        // 1. Has a house number
        // 2. Has a threshold of 0, 1 or 2 (but prefer 0)
        // 3. Does not end " HD"
        //
        // If an address exists in both candidates then ignore the candidate that has an invalid
        // hundred name (as explained above)



        // The first and last street names are most likely to be incorrect.

        for (let index = 0; index < candidates.length; index++) {
            console.log(`Candidate ${index}:`);
            let streetNames = candidates[index].streetNames;
            for (let streetNameIndex = 0; streetNameIndex < streetNames.length; streetNameIndex++) {
                let streetName = streetNames[streetNameIndex];
                console.log(`    Index ${streetNameIndex} (threshold ${streetName.threshold}): ${streetName.houseNumber} ${streetName.streetName}`);
            }
        }

        // let streetName1 = undefined;
        // let streetName2 = undefined;
        // let streetNameTokens = streetName.split("ü");
        // if (streetNameTokens.length === 2) {
        //     // If there is one "ü" character in the street then simply split on this to determine
        //     // the street names.  For example, "SMITH STREETüRAILWAY TERRACE" is simply split into
        //     // "SMITH STREET" and "RAILWAY TERRACE".
        //
        //     streetName1 = streetNameTokens[0];
        //     streetName2 = streetNameTokens[1];
        // } else if (streetNameTokens.length === 3) {
        //     // If there are two "ü" characters then the splitting is more complicated if the
        //     // middle token contains more than one space.
        //
        //     let streetName1Prefix = streetNameTokens[0];
        //     let streetName2Suffix = streetNameTokens[2];
        //     streetNameTokens = streetNameTokens[1].split(" ");
        //     if (streetNameTokens.length === 2) {
        //         // This is a simple case because the middle token contains only one space.  For
        //         // example, "OLIVEüTUCKER PARADEüROAD" becomes "OLIVE PARADE" and "TUCKER ROAD".
        //
        //         streetName1 = streetName1Prefix + " " + streetNameTokens[1];
        //         streetName2 = streetNameTokens[0] + " " + streetName2Suffix;
        //     } else if (streetNameTokens.length === 3) {                
        //         // This is a more complicated case because the middle token contains two spaces.
        //         // For example, in "ROSSLYNüSWIFT WINGS ROADüSTREET" does "WINGS" belong with the
        //         // first street or the second?  Either "ROSSLYN WINGS ROAD"/"SWIFT STREET" would
        //         // result or "ROSSLYN ROAD"/"SWIFT WINGS STREET" would result.  Determining which
        //         // is the reason for the "didyoumean" calls.
        //
        //         streetName1 = streetName1Prefix + " " + streetNameTokens[1] + " " + streetNameTokens[2];
        //         streetName2 = streetNameTokens[0] + " " + streetName2Suffix;
        //         let streetNameMatch1 = didYouMean(streetName1, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
        //         let streetNameMatch2 = didYouMean(streetName2, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
        //         if (streetNameMatch1 === null && streetNameMatch2 === null) {
        //             streetName1 = streetName1Prefix + " " + streetNameTokens[2];
        //             streetName2 = streetNameTokens[0] + " " + streetNameTokens[1] + " " + streetName2Suffix;
        //         }
        //     }
        // }
        //
        // // Remove the "hundred" prefix that appears in some addresses.  Remove the " SA" suffix.
        //
        // let suburbName1 = suburbName.split("ü")[0].replace(/^HD /, "").replace(/ SA$/, "");
        // let suburbName2 = suburbName.split("ü")[1].replace(/^HD /, "").replace(/ SA$/, "");
        //
        // // There are typically two addresses (for example, delineating a corner block).  Prefer
        // // the address that has a house number.
        //
        // if (/[0-9]+[a-zA-Z]?/.test(houseNumber1))
        //     address = houseNumber1 + " " + ((streetName1 === undefined) ? "" : streetName1) + ", " + (SuburbNames[suburbName1.toUpperCase()] || suburbName1);
        // else if (/[0-9]+[a-zA-Z]?/.test(houseNumber2))
        //     address = houseNumber2 + " " + ((streetName2 === undefined) ? "" : streetName2) + ", " + (SuburbNames[suburbName2.toUpperCase()] || suburbName2);
        // else
        //     address = houseNumber1 + " " + ((streetName1 === undefined) ? "" : streetName1) + ", " + (SuburbNames[suburbName1.toUpperCase()] || suburbName1);
    } else {
        suburbName = suburbName.replace(/^HD /, "").replace(/ SA$/, "");
        address = `${houseNumber} ${streetName}, ${SuburbNames[suburbName.toUpperCase()] || suburbName}`;
    }

    address = address.trim().replace(/\s\s+/g, " ");

    // Get the description.

    let description = getDownText(elements, "Development Description", "Relevant Authority", "Private Certifier Name");

    // Construct the resulting application information.
    
    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description === "") ? "No Description Provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : "",
        legalDescription: legalDescription
    };
}

// Parses the development applications in the specified date range.

async function parsePdf(url: string) {
    console.log(`Reading development applications from ${url}.`);

    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has the details of multiple applications.  Note that the PDF is
    // re-parsed on each iteration of the loop (ie. once for each page).  This then avoids large
    // memory usage by the PDF (just calling page._destroy() on each iteration of the loop appears
    // not to be enough to release all memory used by the PDF parsing).

    for (let pageIndex = 0; pageIndex < 500; pageIndex++) {  // limit to an arbitrarily large number of pages (to avoid any chance of an infinite loop)
        let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
        if (pageIndex >= pdf.numPages)
            break;

        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
    
        let elements: Element[] = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
    
            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.
    
            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: workaroundHeight };
        });

        // Release the memory used by the PDF now that it is no longer required (it will be
        // re-parsed on the next iteration of the loop for the next page).

        await pdf.destroy();
        if (global.gc)
            global.gc();

        // Sort the elements by Y co-ordinate and then by X co-ordinate.

        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);

        // Group the elements into sections based on where the "Application No" text starts.

        let applicationElementGroups = [];
        let startElements = findStartElements(elements);
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height) because
            // in some cases the lodged date might be higher up than the "Application No" text.
            
            let startElement = startElements[index];
            let raisedStartElement: Element = {
                text: startElement.text,
                x: startElement.x,
                y: startElement.y - startElement.height / 2,  // leeway
                width: startElement.width,
                height: startElement.height };
            let rowTop = getRowTop(elements, raisedStartElement);
            let nextRowTop = (index + 1 < startElements.length) ? getRowTop(elements, startElements[index + 1]) : Number.MAX_VALUE;

            // Extract all elements between the two rows.

            applicationElementGroups.push({ startElement: startElements[index], elements: elements.filter(element => element.y >= rowTop && element.y + element.height < nextRowTop) });
        }

        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).  If the same application number is encountered a
        // second time in the same document then this likely indicates the parsing has incorrectly
        // recognised some of the digits in the application number.  In this case add a suffix to
        // the application number so it is unique (and so will be inserted into the database later
        // instead of being ignored).

        for (let applicationElementGroup of applicationElementGroups) {
            let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, url);
            if (developmentApplication !== undefined) {
                let suffix = 0;
                let applicationNumber = developmentApplication.applicationNumber;
                while (developmentApplications.some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber))
                    developmentApplication.applicationNumber = `${applicationNumber} (${++suffix})`;  // add a unique suffix
                developmentApplications.push(developmentApplication);
            }
        }
    }

    return developmentApplications;
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read the files containing all possible street names, street suffixes, suburb names and
    // hundred names.

    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName);  // several suburbs may exist for the same street name
    }

    StreetSuffixes = {};
    for (let line of fs.readFileSync("streetsuffixes.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetSuffixTokens = line.toUpperCase().split(",");
        StreetSuffixes[streetSuffixTokens[0].trim()] = streetSuffixTokens[1].trim();
    }

    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].trim()] = suburbTokens[1].trim();
    }

    HundredNames = [];
    for (let line of fs.readFileSync("hundrednames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        HundredNames.push(line.trim().toUpperCase());

    // Read the main page of development applications.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);

    let pdfUrls: string[] = [];

    let elements = []
        .concat($("td.uContentListDesc p a[href$='.pdf']").get())
        .concat($("td.u6ListTD div.u6ListItem a[href$='.pdf']").get())
        .concat($("div.unityHtmlArticle p a[href$='.pdf']").get());

    for (let element of elements) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if (!pdfUrls.some(url => url === pdfUrl))
            pdfUrls.push(pdfUrl);
    }

    // Always parse the most recent PDF file and randomly select one other PDF file to parse.

    if (pdfUrls.length === 0) {
        console.log("No PDF files were found on the page.");
        return;
    }

    console.log(`Found ${pdfUrls.length} PDF file(s).  Selecting two to parse.`);

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    // let selectedPdfUrls: string[] = [];
    // selectedPdfUrls.push(pdfUrls.shift());
    // if (pdfUrls.length > 0)
    //     selectedPdfUrls.push(pdfUrls[getRandom(0, pdfUrls.length)]);
    // if (getRandom(0, 2) === 0)
    //     selectedPdfUrls.reverse();

    // for (let pdfUrl of selectedPdfUrls) {
    for (let pdfUrl of pdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).

        if (global.gc)
            global.gc();

        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
