#!/usr/bin/env bun
const dotenv = require('dotenv');
dotenv.config({quiet: true});
const {cli} = require('./dist/index');

cli()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
